/**
 * **密钥的落盘封存(Win32 DPAPI)**(2026-10-18 / 1.153.0)。
 *
 * 用户拍板“最安全的方法 + 密钥输入即锁定”:面板永远不把 key 读回来,
 * 盘上也不放明文 —— 用 Windows DPAPI(`CurrentUser`)封存,只有**同一台机器、
 * 同一个 Windows 用户**能解开。拷走 `model-slots.json` 到别的机器 = 解不开。
 *
 * 为什么走 PowerShell 而不是第三方包:项目是**零依赖**;DPAPI 的 .NET 类型
 * 在 PowerShell 5.1 里 `Add-Type -AssemblyName System.Security` 之后可用
 * (2026-10-18 本机实测 Protect/Unprotect 往返成功)。
 *
 * ⚠️ 它**只**在保存/启动时调用(两次),不在每条消息的路径上 —— 不拖慢聊天。
 */

import { spawnSync } from 'node:child_process';

const SEAL_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$plain = [Console]::In.ReadToEnd()',
  '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
  '$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, "CurrentUser")',
  '[Convert]::ToBase64String($enc)',
].join('; ');

const UNSEAL_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$b64 = [Console]::In.ReadToEnd()',
  '$bytes = [Convert]::FromBase64String($b64)',
  '$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, "CurrentUser")',
  '[Text.Encoding]::UTF8.GetString($plain)',
].join('; ');

function cleanOutput(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim();
}

/**
 * @param {{spawn?: Function, powershell?: string, timeoutMs?: number, platform?: string}} [options]
 * @returns {{available: boolean, seal: (plain: string) => string, unseal: (sealed: string) => string}}
 */
export function createDpapiSecretBox(options = {}) {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? spawnSync;
  const powershell = options.powershell ?? 'powershell.exe';
  const timeoutMs = Number(options.timeoutMs) || 15_000;

  const run = (script, input) => {
    const result = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: String(input ?? ''),
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (result?.error) throw new Error(`DPAPI 调用失败: ${result.error.message}`);
    if (result?.status !== 0) {
      const detail = cleanOutput(result?.stderr || result?.stdout || '');
      throw new Error(`DPAPI 调用失败(status=${result?.status ?? '?'})${detail ? ': ' + detail.slice(0, 180) : ''}`);
    }
    return cleanOutput(result.stdout);
  };

  if (platform !== 'win32') {
    const fail = () => { throw new Error('DPAPI 只在 Windows 可用'); };
    return { available: false, seal: fail, unseal: fail };
  }

  return {
    available: true,
    seal(plain) {
      if (typeof plain !== 'string' || plain === '') throw new Error('DPAPI seal: 空密钥');
      const sealed = run(SEAL_SCRIPT, plain);
      if (!sealed) throw new Error('DPAPI seal: 空结果');
      return sealed;
    },
    unseal(sealed) {
      if (typeof sealed !== 'string' || sealed === '') throw new Error('DPAPI unseal: 空密文');
      return run(UNSEAL_SCRIPT, sealed);
    },
  };
}
