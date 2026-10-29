#!/usr/bin/env python
"""`scripts\\meitu-classify.py` 的单测(2026-10-24,分类刀 1)。

覆盖(全部真跑,不用模型;用 venv 解释器):
  1. 四概率归一(as-is / softmax / 错误类别数)
  2. 映射边界:g→全年龄、s→r13、q/e→r18、''→未知
  3. 阈值边界:T_E / q+e 合计 / T_13 / T_G 各自刚好过线的两侧
  4. **冲突只升不降**:源 q + 模型全年龄 → 最终 r18 + review;源 g + 模型 r13 → r13
  5. **fail-closed 不对称**:公开档要求"高置信 g + 源 g";源缺失/源 s 时哪怕模型 g 也不公开
  6. **不确定不硬塞档**:低置信 / margin 太近 → final_tier=None + review
  7. 抽检清单确定性(同 seed 同结果)与"review 全部入列"
  8. CLI 契约:--dry 出单条 JSON、退出码 0、输入 hash 稳定;模型缺失时 ok=false 仍退出码 0
  9. 预处理形状/数值范围(384×384、[-1,1])

用法(使用装有 numpy/Pillow 的 Python；无需真实模型/onnxruntime):
  python -B scripts\\selftest-meitu-classify.py
"""
import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "meitu-classify.py"
sys.dont_write_bytecode = True  # 测试与被导入源码均不在仓内生成 __pycache__。
TEMP_FIXTURE = tempfile.TemporaryDirectory(prefix="meitu-classify-fixture-", dir=HERE.parent.parent)
TMP_ROOT = Path(TEMP_FIXTURE.name)
DEFAULT_MODEL = TMP_ROOT / "synthetic-model" / "model.onnx"
DEFAULT_MODEL.parent.mkdir()
DEFAULT_MODEL.write_bytes(b"synthetic-model-hash-fixture-v1")

# 仅CLI报告/隐私测试注入确定性推理依赖；仍真跑图像预处理、分类、报告与子进程CLI。
# 不声称覆盖真实ONNX图/推理引擎；--dry原本也只验文件元信息，不加载模型。
FAKE_INFERENCE_CODE = """
import runpy, sys, types
class FixtureSession:
    def __init__(self, *args, **kwargs): pass
    def get_inputs(self): return [types.SimpleNamespace(name='input')]
    def get_outputs(self): return [types.SimpleNamespace(name='output')]
    def run(self, names, feed):
        assert names == ['output']
        assert feed['input'].shape == (1, 3, 384, 384)
        assert -1 <= float(feed['input'].min()) <= float(feed['input'].max()) <= 1
        return [[0.90, 0.06, 0.03, 0.01]]
sys.modules['onnxruntime'] = types.SimpleNamespace(SessionOptions=type('Options', (), {}), InferenceSession=FixtureSession)
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
"""


def load_module():
    spec = importlib.util.spec_from_file_location("meitu_classify", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mc = load_module()



def probs(g, s, q, e):
    return {"g": g, "s": s, "q": q, "e": e}


class ProbsTest(unittest.TestCase):
    def test_as_is(self):
        arr, how = mc.normalize_probs([0.1, 0.2, 0.3, 0.4])
        self.assertEqual(how, "as-is")
        self.assertAlmostEqual(float(arr.sum()), 1.0, places=6)

    def test_softmax(self):
        arr, how = mc.normalize_probs([1.0, 2.0, 3.0, 4.0])
        self.assertEqual(how, "softmax")
        self.assertAlmostEqual(float(arr.sum()), 1.0, places=6)

    def test_wrong_size(self):
        with self.assertRaises(ValueError):
            mc.normalize_probs([0.5, 0.5, 0.0])


class MappingTest(unittest.TestCase):
    def test_rating_to_tier(self):
        self.assertEqual(mc.RATING_TO_TIER["g"], mc.TIER_ALL)
        self.assertEqual(mc.RATING_TO_TIER["safe"], mc.TIER_ALL)
        self.assertEqual(mc.RATING_TO_TIER["s"], mc.TIER_R13)
        self.assertEqual(mc.RATING_TO_TIER["q"], mc.TIER_R18)
        self.assertEqual(mc.RATING_TO_TIER["e"], mc.TIER_R18)
        self.assertIsNone(mc.RATING_TO_TIER.get(""))

    def test_tier_max(self):
        self.assertEqual(mc.tier_max(mc.TIER_ALL, mc.TIER_R13), mc.TIER_R13)
        self.assertEqual(mc.tier_max(mc.TIER_R18, mc.TIER_R13), mc.TIER_R18)
        self.assertEqual(mc.tier_max(None, mc.TIER_R13), mc.TIER_R13)
        self.assertEqual(mc.tier_max(mc.TIER_ALL, None), mc.TIER_ALL)


class ThresholdTest(unittest.TestCase):
    def test_general_high(self):
        d = mc.classify_probs(probs(0.90, 0.06, 0.03, 0.01), "g")
        self.assertEqual(d["model_tier"], mc.TIER_ALL)
        self.assertEqual(d["final_tier"], mc.TIER_ALL)
        self.assertFalse(d["review"])
        self.assertTrue(d["public_ok"])

    def test_sensitive_high(self):
        d = mc.classify_probs(probs(0.05, 0.85, 0.07, 0.03), "s")
        self.assertEqual(d["model_tier"], mc.TIER_R13)
        self.assertEqual(d["final_tier"], mc.TIER_R13)
        self.assertFalse(d["review"])
        self.assertFalse(d["public_ok"])

    def test_explicit_hard_rule(self):
        # T_E=0.60:p_e 刚过线 → r18,不看别的
        d = mc.classify_probs(probs(0.05, 0.10, 0.24, 0.61), "g")
        self.assertEqual(d["model_tier"], mc.TIER_R18)

    def test_qe_sum_rule(self):
        # p_e=0.30 没过 T_E,但 p_q+p_e=0.70 ≥ T_18
        d = mc.classify_probs(probs(0.10, 0.20, 0.40, 0.30), "s")
        self.assertEqual(d["model_tier"], mc.TIER_R18)

    def test_just_below_thresholds(self):
        # 全部刚好不到线:g .69 / s .20 / q .08 / e .03 → low_confidence,不硬塞
        d = mc.classify_probs(probs(0.69, 0.20, 0.08, 0.03), "g")
        self.assertIsNone(d["model_tier"])
        self.assertIsNone(d["final_tier"])
        self.assertIn("low_confidence", d["review_reasons"])
        self.assertTrue(d["review"])

    def test_margin_rule(self):
        # p_s=.55 ≥ T_13,但 top1-top2=.13 < T_MARGIN=.15 → 撤回到 review(不硬塞 r13)
        d = mc.classify_probs(probs(0.42, 0.55, 0.02, 0.01), "s")
        self.assertIn("margin", d["review_reasons"])
        self.assertIsNone(d["final_tier"])
        self.assertTrue(d["review"])

    def test_config_override(self):
        strict = {"T_G": 0.99}
        d = mc.classify_probs(probs(0.90, 0.06, 0.03, 0.01), "g", strict)
        self.assertIsNone(d["model_tier"])  # g .90 过不了 .99,其余更低 → low_confidence

    def test_config_override_mapping_still_public(self):
        # 阈值可以松,但公开档的"源 g"要求不受阈值影响
        loose = {"T_G": 0.50}
        d = mc.classify_probs(probs(0.60, 0.25, 0.10, 0.05), "s", loose)
        self.assertEqual(d["model_tier"], mc.TIER_ALL)
        self.assertFalse(d["public_ok"])


class ConflictTest(unittest.TestCase):
    def test_source_q_model_general_only_up(self):
        d = mc.classify_probs(probs(0.90, 0.06, 0.03, 0.01), "q")
        self.assertEqual(d["model_tier"], mc.TIER_ALL)
        self.assertEqual(d["final_tier"], mc.TIER_R18)  # 只升不降
        self.assertTrue(d["conflict"])
        self.assertTrue(d["review"])
        self.assertFalse(d["public_ok"])

    def test_source_g_model_r13(self):
        d = mc.classify_probs(probs(0.05, 0.85, 0.07, 0.03), "g")
        self.assertEqual(d["final_tier"], mc.TIER_R13)
        self.assertTrue(d["conflict"])
        self.assertTrue(d["review"])

    def test_source_q_model_r18_agree(self):
        d = mc.classify_probs(probs(0.02, 0.10, 0.28, 0.60), "q")
        self.assertEqual(d["final_tier"], mc.TIER_R18)
        self.assertFalse(d["conflict"])
        self.assertFalse(d["review"])

    def test_source_e_model_r18(self):
        d = mc.classify_probs(probs(0.01, 0.04, 0.10, 0.85), "e")
        self.assertEqual(d["final_tier"], mc.TIER_R18)
        self.assertFalse(d["review"])

    def test_source_missing_fail_closed(self):
        d = mc.classify_probs(probs(0.90, 0.06, 0.03, 0.01), "")
        self.assertEqual(d["final_tier"], mc.TIER_ALL)
        self.assertIn("source_missing", d["review_reasons"])
        self.assertTrue(d["review"])
        self.assertFalse(d["public_ok"])  # 源没回填 → 永不可公开


class PublicRuleTest(unittest.TestCase):
    def test_public_low_confidence_g(self):
        # 模型全年龄、源 g,但 p_g=.84 < PUBLIC_MIN_G=.85 → 不公开
        d = mc.classify_probs(probs(0.84, 0.10, 0.04, 0.02), "g")
        self.assertEqual(d["final_tier"], mc.TIER_ALL)
        self.assertFalse(d["public_ok"])

    def test_public_good(self):
        d = mc.classify_probs(probs(0.88, 0.07, 0.03, 0.02), "g")
        self.assertTrue(d["public_ok"])
        self.assertFalse(d["review"])


class AgreementTest(unittest.TestCase):
    def test_counts(self):
        results = [
            {"source_tier": "r13", "tier_soft": "r13", "final_tier": "r13"},
            {"source_tier": "all_ages", "tier_soft": "all_ages", "final_tier": "all_ages"},
            {"source_tier": "r18", "tier_soft": "r13", "final_tier": None},
            {"source_tier": None, "tier_soft": "all_ages", "final_tier": None},
        ]
        stats = mc.agreement_stats(results)
        self.assertEqual(stats["known"], 3)
        self.assertEqual(stats["soft_agree"], 2)
        self.assertEqual(stats["decisive"], 2)
        self.assertEqual(stats["decisive_agree"], 2)
        self.assertAlmostEqual(stats["agreement_soft"], 0.6667, places=4)
        self.assertAlmostEqual(stats["decisive_share"], 0.6667, places=4)


class InspectionTest(unittest.TestCase):
    def _images(self):
        images = []
        for i in range(40):
            tier = (mc.TIER_ALL, mc.TIER_R13, mc.TIER_R18)[i % 3]
            images.append({"path": f"D:/x/{i:03d}.jpg", "tier": tier, "review": False, "conflict": False})
        images.append({"path": "D:/x/900.jpg", "tier": None, "review": True, "conflict": True})
        images.append({"path": "D:/x/901.jpg", "tier": None, "review": True, "conflict": False})
        images.append({"path": "D:/x/902.jpg", "tier": mc.TIER_ALL, "review": True, "conflict": False})
        return images

    def test_deterministic(self):
        a = mc.pick_inspection(self._images(), 12, 42)
        b = mc.pick_inspection(self._images(), 12, 42)
        self.assertEqual([item["path"] for item in a], [item["path"] for item in b])

    def test_review_all_included(self):
        picked = mc.pick_inspection(self._images(), 12, 42)
        paths = {item["path"] for item in picked}
        for must in ("D:/x/900.jpg", "D:/x/901.jpg", "D:/x/902.jpg"):
            self.assertIn(must, paths)

    def test_cap(self):
        picked = mc.pick_inspection(self._images(), 6, 42)
        self.assertLessEqual(len(picked), 16)  # sample+10 上限
        self.assertGreater(len(picked), 0)


class PreprocessTest(unittest.TestCase):
    def test_shape_and_range(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("无 Pillow")
        arr = mc.preprocess(mc.load_image(Image.new("RGB", (100, 50), (255, 255, 255))), 384)
        self.assertEqual(arr.shape, (3, 384, 384))
        self.assertGreaterEqual(float(arr.min()), -1.0 - 1e-6)
        self.assertLessEqual(float(arr.max()), 1.0 + 1e-6)
        # 纯白 → 归一后应≈1
        self.assertAlmostEqual(float(arr.max()), 1.0, places=5)

    def test_alpha_white_background(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("无 Pillow")
        img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        out = mc.load_image(img)
        self.assertEqual(out.mode, "RGB")
        self.assertEqual(out.getpixel((0, 0)), (255, 255, 255))


class EvalModeTest(unittest.TestCase):
    def test_scan_spec(self):
        self.assertEqual(mc.parse_scan_spec(r"E:\fixture-images\合成目录甲"), ("合成目录甲", Path(r"E:\fixture-images\合成目录甲")))
        self.assertEqual(mc.parse_scan_spec(r"合成标签乙=E:\fixture-images\合成目录乙"), ("合成标签乙", Path(r"E:\fixture-images\合成目录乙")))

    def test_summarize_folder(self):
        entries = [
            {"final_tier": "all_ages", "tier_soft": "all_ages", "review": False, "model_top1": "general", "probs": {"g": 0.8, "s": 0.1, "q": 0.05, "e": 0.05}, "review_reasons": []},
            {"final_tier": "r18", "tier_soft": "r18", "review": False, "model_top1": "explicit", "probs": {"g": 0.05, "s": 0.1, "q": 0.3, "e": 0.55}, "review_reasons": []},
            {"final_tier": None, "tier_soft": "r13", "review": True, "model_top1": "sensitive", "probs": {"g": 0.1, "s": 0.5, "q": 0.2, "e": 0.2}, "review_reasons": ["margin"]},
        ]
        s = mc.summarize_folder("测试夹", entries, [])
        self.assertEqual(s["images"], 3)
        self.assertEqual(s["tiers"]["all_ages"], 1)
        self.assertEqual(s["tiers"]["r18"], 1)
        self.assertEqual(s["review"], 1)
        self.assertEqual(s["low_tier"], 1)          # 最终档 = all_ages 的那张
        self.assertEqual(s["soft_low_tier"], 2)     # argmax = general/sensitive 的两张
        self.assertAlmostEqual(s["mean_probs"]["e"], (0.05 + 0.55 + 0.2) / 3, places=3)

    def test_pick_eval_samples_includes_review_and_is_deterministic(self):
        entries = [
            {"id": f"夹#{i:03d}", "final_tier": ("all_ages", "r13", "r18")[i % 3], "review": False}
            for i in range(1, 31)
        ]
        entries.append({"id": "夹#900", "final_tier": None, "review": True})
        a = [item["id"] for item in mc.pick_eval_samples(entries, 10, 7, "夹")]
        b = [item["id"] for item in mc.pick_eval_samples(entries, 10, 7, "夹")]
        self.assertEqual(a, b)
        self.assertIn("夹#900", a)
        self.assertLessEqual(len(a), 10)

    def test_scan_mode_no_filenames_in_report(self):
        """CLI 契约:--scan 评估报告里不许出现文件名/路径(隐私红线,用假目录 fixture 真跑)。"""
        tmp = Path(tempfile.mkdtemp(prefix="meitu-eval-selftest-", dir=str(TMP_ROOT)))
        try:
            folder = tmp / "测试夹"
            folder.mkdir()
            try:
                from PIL import Image
                for name in ("aaa.png", "bbb.png"):
                    Image.new("RGB", (8, 8), (128, 128, 128)).save(folder / name)
            except Exception:
                self.skipTest("无 Pillow")
            proc = subprocess.run(
                [sys.executable, "-B", "-c", FAKE_INFERENCE_CODE, str(SCRIPT),
                 "--model", str(DEFAULT_MODEL), "--meta", str(TMP_ROOT / "absent-meta.json"),
                 "--scan", f"测试夹={folder}", "--stats-only", "另一夹",
                 "--sample-per-folder", "2", "--eval-out", str(tmp / "out"), "--tag", "selftest"],
                capture_output=True, text=True, encoding="utf-8", timeout=180,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr[-800:])
            lines = [line for line in (proc.stdout or "").splitlines() if line.strip()]
            payload = json.loads(lines[-1])
            self.assertTrue(payload["ok"], payload)
            text = Path(payload["report"]).read_text(encoding="utf-8") + Path(payload["markdown"]).read_text(encoding="utf-8")
            self.assertNotIn("aaa.png", text)
            self.assertNotIn("bbb.png", text)
            self.assertNotIn(str(tmp), text)
            self.assertIn("测试夹#", text)
            self.assertIn("弱先验", Path(payload["markdown"]).read_text(encoding="utf-8"))
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


class CliContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="meitu-classify-selftest-", dir=str(TMP_ROOT)))
        db = cls.tmp / "mini.db"
        conn = sqlite3.connect(db)
        conn.execute(
            "CREATE TABLE meitu_meta (file_path TEXT, source TEXT, source_id TEXT, rating TEXT, characters TEXT)"
        )
        # 真存在的一张图 + 一条缺文件的记录(验证 missing 计数)
        real = cls.tmp / "a.png"
        try:
            from PIL import Image
            Image.new("RGB", (8, 8), (128, 128, 128)).save(real)
        except Exception:
            real.write_bytes(b"not-an-image")
        conn.execute("INSERT INTO meitu_meta VALUES (?,?,?,?,?)", (str(real), "danbooru", "1", "g", "[]"))
        conn.execute("INSERT INTO meitu_meta VALUES (?,?,?,?,?)", (str(cls.tmp / "gone.jpg"), "danbooru", "2", "q", "[]"))
        conn.commit()
        conn.close()
        cls.db = db

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _run(self, extra):
        proc = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--meta", str(TMP_ROOT / "absent-meta.json"), *extra],
            capture_output=True, text=True, encoding="utf-8", timeout=120,
        )
        lines = [line.strip() for line in (proc.stdout or "").splitlines() if line.strip()]
        payload = json.loads(lines[-1]) if lines else None
        return proc, payload

    def test_dry_run_contract(self):
        self.assertTrue(DEFAULT_MODEL.is_file(), "模型不在预期路径,无法验 --dry 的模型段")
        proc, payload = self._run(["--db", str(self.db), "--model", str(DEFAULT_MODEL), "--dry", "--out-dir", str(self.tmp)])
        self.assertEqual(proc.returncode, 0)
        self.assertIsNotNone(payload)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["dry"])
        self.assertEqual(payload["rows"], 2)
        self.assertEqual(payload["present"], 1)
        self.assertEqual(payload["missing"], 1)
        self.assertRegex(payload["input_hash"], r"^[0-9a-f]{64}$")
        self.assertRegex(payload["model"]["sha256"], r"^[0-9a-f]{64}$")

    def test_input_hash_stable(self):
        _, a = self._run(["--db", str(self.db), "--model", str(DEFAULT_MODEL), "--dry", "--out-dir", str(self.tmp)])
        _, b = self._run(["--db", str(self.db), "--model", str(DEFAULT_MODEL), "--dry", "--out-dir", str(self.tmp)])
        self.assertEqual(a["input_hash"], b["input_hash"])

    def test_missing_model_is_json_error_exit0(self):
        proc, payload = self._run(["--db", str(self.db), "--model", str(self.tmp / "nope.onnx"), "--out-dir", str(self.tmp)])
        self.assertEqual(proc.returncode, 0)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["reason"], "FileNotFoundError")


if __name__ == "__main__":
    unittest.main(verbosity=2)
