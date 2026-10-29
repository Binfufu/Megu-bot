/**
 * 「<发/来/找/搬><N>张<角色名><美图/涩图>」的**解析器**。
 * (1.181.0 美图/涩图分档 + 动词加「搬」+ 残缺指令兜底;1.179.1 扩动词/中文数字/@残留)
 *
 * 本模块是确定性解析器；正常命中不经过模型，找图/下载/发送仍走代码(见 `src\meitu-service.js`
 * 与 `scripts\meitu-fetch-one.mjs`)。1.204.0 起仅服务层角色未命中时单次模型理解，产物严格校验。
 * 格式写歪了仍要**明确回一句格式提示**,而不是把它当闲聊丢掉。
 *
 * 认的写法(群里 @ 之后的文本;⚠️ 部分客户端会把 @名字 当**纯文本**留在正文里,
 * 网关只剥段落 @ —— 所以开头残留 `@副实例 ` 也要剥,见 `stripLeadingAt`):
 *
 *     发1张示例丙涩图，要足控的          ← 完整格式(美图=全年龄唯美,涩图=擦边)
 *     来 3 张 示例甲 美图 足控
 *     搬两张示例乙涩图                  ← 动词 发/来/找/搬 都认(1.181.0 加「搬」)
 *     来3张随便的                     ← **残缺指令**:提取不出角色就随机挑登记过的角色
 *     来3张随机双马尾美图              ← **随机角色**(1.184.0):「随机」后可跟修饰,粘连也认
 *     来2张随机足控涩图                ← 随机角色 + 涩图档 + 修饰
 *     来2张                           ← 什么都不给 = 随机角色 + 随机热门图(美图档)
 *     找两张示例丙美图               ← 中文数字也认(一/两/二…九/十/十几)
 *     ，发2张示例乙美图。
 *     再来五张示例丁美图，要泳装的      ← **前缀噪点**(2026-10-23):指令前允许最多
 *                                        `MAX_NOISE_PREFIX` 字的闲聊/语气词/名字;
 *                                        见下面「噪点前缀」那一节。
 *     来几张示例甲美图                    ← **「几张」= 5 张**(1.199.0,主人拍板):问句量词
 *                                        直接按五张执行;完整/残缺/@残留 三条路都认;
 *                                        「十几张/几十几」**不认**(落不到数字 → 格式提示,
 *                                        宁窄勿宽);「发来了几张…」这类转述句护栏天然不咬。
 *
 * 两档(2026-10-23 主人拍板的检索口径):
 *   · **美图**(tier=`meitu`) = 正常的 r13 偏全年龄唯美图(Danbooru g/s,Safebooru safe);
 *   · **涩图**(tier=`seitu`) = 现在的擦边档(Danbooru s/q,Safebooru questionable)。
 * 写「美图」但修饰里带「擦边/涩」→ 升级成涩图档(兼容 1.179.x 的老写法)。
 *
 * 解析顺序(每一步都只做一件小事,单测按表钉着):
 *   ⓪ **指令不见得在开头**(2026-10-23,主人拍板):群里真正那条是「再来五张示例丁美图，
 *      要泳装的」—— 前面一个「再」就整条落到模型那边去了(1.188.0 现场:14:44 那条
 *      走了 LLM,同一条去掉「再」就正常出图)。所以**先按开头解析,失败再在
 *      前 `MAX_NOISE_PREFIX`(24)字里找指令起点**,找到就从那里往下按同一套规则解析
 *      (`parseAfterNoise()`);**复合词护栏**挡住「回来/出来/头发/寻找」这类
 *      动词只是词尾的情况(`COMPOUND_BEFORE`);前缀里全是噪点(闲聊/语气词/名字)才认。
 *   ① trim → 去前导 `[，,、\s]+` → 去句末 `[。！!]+` → **剥前导 @残留**;
 *   ② **完整指令** `/^(?:发|来|找|搬)\s*(数量)\s*张\s*(.+?)\s*(美图|涩图|色图|擦边图)\s*(.*)$/u`
 *      一刀切出 数量/角色/名词/修饰;
 *   ③ **残缺指令** `/^(?:发|来|找|搬)\s*(数量?)\s*张\s*(.*)$/u`:动词+张就接 ——
 *      剩余段里**提取到什么就搜什么**(名词定档、修饰词进 tags、第一个实词当角色);
 *      什么都提取不出来(空 / 纯「随便/都行」类虚词)→ `random: true`,由服务层
 *      从别名表随机挑角色、按 score 挑热门图;数量没写默认 1【暂定】;
 *      ⚠️ 没写数量时角色常与档位名词**粘成一段**(「来张示例甲美图」「搬张示例乙涩图」),
 *      要先按词尾把名词剥出来定档,不能整段当角色名(1.183.1 修:以前剥成「示例甲美」
 *      → 别名表查不到 → 回「没登记」,涩图档还会退成美图档);
 *      ⚠️ **「随机」标记词**(1.184.0):角色位写「随机/随便/任意/随缘…」= `random: true`,
 *      后面**粘着的修饰**用认识的词最长匹配切开(「随机白丝双马尾」→ thighhighs+twintails);
 *      标记词**不进别名表**(否则随机模式会抽到它自己、图库多一个叫「随机」的角色);
 *   ④ 数量:阿拉伯或中文数字;0 或非法 → reason;超过上限**夹到上限**(默认 5【暂定】);
 *   ⑤ 角色:去尾部「的/图/片」等,不能空(空 = random);
 *   ⑥ 修饰:去前导「要/请」,按 `[，,、;；\s]+` 切词,每词去尾部「的/图/向/级/片」;
 *   ⑦ 关键词映射 → `TAG_WORDS` 大表(1.183.0 按"读一遍图源"扩全:发型/发色/瞳色/
 *      兽耳/服装/泳装/袜鞋/配饰/姿势/表情/构图/场景…全部映射到**图源实测存在**的
 *      danbooru tag,验证方式见 `scripts\selftest-meitu-command.js` 的元判据);
 *      纯 ASCII 的 tag 形状(`/^[a-z0-9_()]+$/i`)原样当标签;其余进 `ignored`(只记日志)。
 *      ⚠️ **一个修饰都没命中就依旧不加修饰**:tags=[] 时查询只带角色(+档位 rating 限定),
 *      不会硬塞兜底词 —— 没有匹配就不限制,这是主人定的口径;
 *      ⚠️ **最多保留 2 个标签**(图源匿名查询的 tag 预算:角色 + 一个修饰),多出的进 ignored。
 *
 * ⚠️ 除「涩图档的未成年外观标签黑名单 fail-closed」之外**不加任何内容限制** ——
 *    人外、mature 之类的旧白名单**不搬**(主人明确说不要擅自加限制)。
 */

/**
 * 修饰词 → 标签。顺序有意义:「足控」要先于「足」,否则只切出「足」以外的部分;
 * 单词条是全等匹配(剥尾后),没有子串误命中问题,同 tag 多叫法写进同一个 words 数组。
 * ⚠️ 表里每个 tag 都在 Danbooru **实测存在且 ≥100 帖**(2026-10-23 name_comma 批量验证);
 *    往表里加新 tag 前先跑一遍同样的验证 —— 错 tag = 图源 0 结果 = 用户扑空。
 * ⚠️ 不许加「萝莉/幼女」类词 —— 黑名单(`MINOR_TAGS`)是前缀级 fail-closed,
 *    映射过去只会让搜出来的图整批被拦。
 */
export const TAG_WORDS = [
  // ——— 身体/性癖向(1.179.x 起) ———
  { words: ['足控', '玉足', '足', '脚'], tag: 'feet' },
  { words: ['胸控', '巨乳'], tag: 'large_breasts' },
  { words: ['单人'], tag: 'solo' },
  { words: ['多人'], tag: 'multiple_girls' },
  { words: ['白丝'], tag: 'thighhighs' },
  { words: ['黑丝', '丝袜'], tag: 'pantyhose' },
  { words: ['泳装'], tag: 'swimsuit' },
  // ——— 以下 1.183.0 扩表(全部实测过) ———
  // 贫乳/身体
  { words: ['贫乳'], tag: 'flat_chest' },
  { words: ['长腿'], tag: 'long_legs' },
  { words: ['肚脐'], tag: 'navel' },
  { words: ['露脐'], tag: 'midriff' },
  { words: ['锁骨'], tag: 'collarbone' },
  { words: ['腋下'], tag: 'armpits' },
  { words: ['侧乳'], tag: 'sideboob' },
  { words: ['下乳'], tag: 'underboob' },
  { words: ['裸足'], tag: 'barefoot' },
  // 发型
  { words: ['长发'], tag: 'long_hair' },
  { words: ['短发'], tag: 'short_hair' },
  { words: ['双马尾'], tag: 'twintails' },
  { words: ['马尾', '单马尾'], tag: 'ponytail' },
  { words: ['侧马尾'], tag: 'side_ponytail' },
  { words: ['丸子头'], tag: 'hair_bun' },
  { words: ['双丸子'], tag: 'double_bun' },
  { words: ['姬发式'], tag: 'hime_cut' },
  { words: ['呆毛'], tag: 'ahoge' },
  { words: ['卷发'], tag: 'wavy_hair' },
  { words: ['直发'], tag: 'straight_hair' },
  { words: ['辫子', '麻花辫'], tag: 'braid' },
  { words: ['双辫'], tag: 'twin_braids' },
  { words: ['波波头'], tag: 'bob_cut' },
  { words: ['刘海'], tag: 'blunt_bangs' },
  // 发色
  { words: ['金发'], tag: 'blonde_hair' },
  { words: ['灰发', '银发'], tag: 'grey_hair' },
  { words: ['白发'], tag: 'white_hair' },
  { words: ['黑发'], tag: 'black_hair' },
  { words: ['红发'], tag: 'red_hair' },
  { words: ['粉发'], tag: 'pink_hair' },
  { words: ['蓝发'], tag: 'blue_hair' },
  { words: ['紫发'], tag: 'purple_hair' },
  { words: ['绿发'], tag: 'green_hair' },
  { words: ['棕发'], tag: 'brown_hair' },
  { words: ['橘发'], tag: 'orange_hair' },
  { words: ['灰发'], tag: 'grey_hair' },
  // 瞳
  { words: ['异色瞳'], tag: 'heterochromia' },
  { words: ['蓝眼', '蓝瞳'], tag: 'blue_eyes' },
  { words: ['红眼', '红瞳'], tag: 'red_eyes' },
  { words: ['金瞳'], tag: 'yellow_eyes' },
  { words: ['绿眼', '绿瞳'], tag: 'green_eyes' },
  { words: ['紫眼', '紫瞳'], tag: 'purple_eyes' },
  // 兽耳/非人特征
  { words: ['猫耳'], tag: 'cat_ears' },
  { words: ['狐耳'], tag: 'fox_ears' },
  { words: ['兔耳'], tag: 'rabbit_ears' },
  { words: ['兽耳'], tag: 'animal_ears' },
  { words: ['狼耳'], tag: 'wolf_ears' },
  { words: ['尾巴'], tag: 'tail' },
  { words: ['猫尾'], tag: 'cat_tail' },
  { words: ['角'], tag: 'horns' },
  { words: ['恶魔角'], tag: 'demon_horns' },
  { words: ['恶魔'], tag: 'demon_girl' },
  { words: ['天使'], tag: 'angel' },
  { words: ['翅膀'], tag: 'wings' },
  { words: ['天使翅膀'], tag: 'angel_wings' },
  { words: ['光环'], tag: 'halo' },
  { words: ['尖耳'], tag: 'pointy_ears' },
  { words: ['猫娘'], tag: 'cat_girl' },
  { words: ['狐娘'], tag: 'fox_girl' },
  { words: ['狼娘'], tag: 'wolf_girl' },
  { words: ['兽娘'], tag: 'monster_girl' },
  { words: ['人鱼'], tag: 'mermaid' },
  { words: ['精灵'], tag: 'elf' },
  // 脸部/配饰
  { words: ['眼镜'], tag: 'glasses' },
  { words: ['墨镜'], tag: 'sunglasses' },
  { words: ['眼罩'], tag: 'blindfold' },
  { words: ['泪痣'], tag: 'mole_under_eye' },
  { words: ['口罩'], tag: 'mask' },
  { words: ['面纱'], tag: 'veil' },
  { words: ['帽子'], tag: 'hat' },
  { words: ['贝雷帽'], tag: 'beret' },
  { words: ['发饰'], tag: 'hair_ornament' },
  { words: ['蝴蝶结'], tag: 'hair_bow' },
  { words: ['发带'], tag: 'hairband' },
  { words: ['耳环'], tag: 'earrings' },
  { words: ['项链'], tag: 'necklace' },
  { words: ['项圈'], tag: 'collar' },
  { words: ['手套'], tag: 'gloves' },
  { words: ['露指手套'], tag: 'fingerless_gloves' },
  // 服装
  { words: ['女仆', '女仆装'], tag: 'maid' },
  { words: ['兔女郎'], tag: 'playboy_bunny' },
  { words: ['巫女'], tag: 'miko' },
  { words: ['修女'], tag: 'nun' },
  { words: ['护士'], tag: 'nurse' },
  { words: ['女警'], tag: 'police' },
  { words: ['军装'], tag: 'military_uniform' },
  { words: ['校服', 'JK'], tag: 'school_uniform' },
  { words: ['水手服'], tag: 'serafuku' },
  { words: ['体操服'], tag: 'gym_uniform' },
  { words: ['死库水'], tag: 'school_swimsuit' },
  { words: ['布鲁玛'], tag: 'buruma' },
  { words: ['围裙'], tag: 'apron' },
  { words: ['偶像'], tag: 'idol' },
  { words: ['哥特萝莉'], tag: 'gothic_lolita' },
  { words: ['洛丽塔'], tag: 'lolita_fashion' },
  { words: ['婚纱'], tag: 'wedding_dress' },
  { words: ['旗袍'], tag: 'qipao' },
  { words: ['汉服'], tag: 'hanfu' },
  { words: ['和服'], tag: 'kimono' },
  { words: ['浴衣'], tag: 'yukata' },
  { words: ['振袖'], tag: 'furisode' },
  { words: ['忍者'], tag: 'ninja' },
  { words: ['武士'], tag: 'samurai' },
  { words: ['骑士'], tag: 'knight' },
  { words: ['魔法少女'], tag: 'magical_girl' },
  { words: ['睡衣'], tag: 'pajamas' },
  { words: ['湿身'], tag: 'wet_clothes' },
  { words: ['比基尼'], tag: 'bikini' },
  { words: ['竞赛泳装'], tag: 'competition_swimsuit' },
  { words: ['连体泳装'], tag: 'one-piece_swimsuit' },
  // 袜鞋
  { words: ['吊带袜'], tag: 'garter_belt' },
  { words: ['绝对领域'], tag: 'zettai_ryouiki' },
  { words: ['高跟鞋'], tag: 'high_heels' },
  { words: ['靴子'], tag: 'boots' },
  { words: ['过膝靴'], tag: 'thigh_boots' },
  { words: ['袖套'], tag: 'detached_sleeves' },
  // 姿势/动作
  { words: ['坐', '坐姿', '坐着'], tag: 'sitting' },
  { words: ['站', '站姿', '站着'], tag: 'standing' },
  { words: ['躺', '躺着'], tag: 'lying' },
  { words: ['趴', '趴着'], tag: 'on_stomach' },
  { words: ['跪坐'], tag: 'seiza' },
  { words: ['蹲', '蹲着'], tag: 'squatting' },
  { words: ['睡觉', '睡着'], tag: 'sleeping' },
  { words: ['回头'], tag: 'looking_back' },
  { words: ['跳跃'], tag: 'jumping' },
  { words: ['奔跑'], tag: 'running' },
  { words: ['走路'], tag: 'walking' },
  { words: ['飞行'], tag: 'flying' },
  { words: ['漂浮'], tag: 'floating' },
  { words: ['弯腰'], tag: 'bent_over' },
  { words: ['伸懒腰'], tag: 'stretching' },
  { words: ['打哈欠'], tag: 'yawning' },
  { words: ['招手'], tag: 'beckoning' },
  { words: ['叉腰'], tag: 'hands_on_own_hips' },
  { words: ['托腮'], tag: 'head_rest' },
  // 表情
  { words: ['微笑', '笑'], tag: 'smile' },
  { words: ['大笑'], tag: 'laughing' },
  { words: ['张嘴'], tag: 'open_mouth' },
  { words: ['闭眼'], tag: 'closed_eyes' },
  { words: ['眨眼', 'wink'], tag: 'one_eye_closed' },
  { words: ['吐舌'], tag: 'tongue' },
  { words: ['哭'], tag: 'crying' },
  { words: ['流泪'], tag: 'tears' },
  { words: ['生气'], tag: 'angry' },
  { words: ['惊讶'], tag: 'surprised' },
  { words: ['害羞'], tag: 'embarrassed' },
  // 构图/视角
  { words: ['背面', '背影'], tag: 'from_behind' },
  { words: ['俯视'], tag: 'from_above' },
  { words: ['仰视'], tag: 'from_below' },
  { words: ['特写'], tag: 'close-up' },
  { words: ['半身'], tag: 'upper_body' },
  { words: ['全身'], tag: 'full_body' },
  // 场景
  { words: ['海边'], tag: 'beach' },
  { words: ['泳池'], tag: 'pool' },
  { words: ['温泉'], tag: 'onsen' },
  { words: ['泡澡'], tag: 'bathing' },
  { words: ['水下'], tag: 'underwater' },
  { words: ['雨'], tag: 'rain' },
  { words: ['雪'], tag: 'snow' },
  { words: ['樱花'], tag: 'cherry_blossoms' },
  { words: ['夜晚'], tag: 'night' },
  { words: ['星空'], tag: 'star_(sky)' },
  { words: ['夕阳'], tag: 'sunset' },
  { words: ['教室'], tag: 'classroom' },
  { words: ['床'], tag: 'bed' },
  { words: ['卧室'], tag: 'bedroom' },
  { words: ['城市'], tag: 'city' },
  { words: ['图书馆'], tag: 'library' },
  { words: ['神社'], tag: 'shrine' },
  { words: ['雨伞'], tag: 'umbrella' },
  // 互动/小物
  { words: ['拥抱'], tag: 'hug' },
  { words: ['牵手'], tag: 'holding_hands' },
  { words: ['摸头'], tag: 'headpat' },
  { words: ['公主抱'], tag: 'princess_carry' },
  { words: ['猫'], tag: 'cat' },
  { words: ['狗'], tag: 'dog' },
  { words: ['兔子'], tag: 'rabbit' },
  { words: ['剑'], tag: 'sword' },
  { words: ['法杖'], tag: 'staff' },
  { words: ['机娘'], tag: 'android' },
];

/** 每个词**可能**拖着的尾巴(「足控向」「擦边的」「泳装图」「壁纸片」)。 */
const WORD_TAILS = ['的', '图', '向', '级', '片'];

/** 档位名词 → tier。「涩图/色图/擦边图」都是涩图档(「色图」是常见打字变体)。 */
const NOUN_TIERS = { 美图: 'meitu', 涩图: 'seitu', 色图: 'seitu', 擦边图: 'seitu' };

/**
 * **随机标记词**(1.184.0,主人要的「来N张随机<修饰>美图」):角色位写这些 = 不下角色名,
 * 由服务层从别名表随机挑一个 —— 挑中的**中文名**照旧决定落盘目录与图库分类(不是"随机"这个目录)。
 * ⚠️ 它**不进别名表**:别名表的契约是「中文角色名 → 图源 tag」;塞一个没有 tag 的假角色,
 *    随机模式会抽到它自己(→ 查 `随机` 这个 tag → 0 结果),图库分类里也会多一个叫「随机」的角色。
 *    **词形识别放在解析器这一层**,数据表保持干净。
 * ⚠️ 数组按**长度从长到短**写(前缀匹配取第一个命中的)。
 */
const RANDOM_WORDS = ['随机角色', '随机一个', '随机图片', '随便哪个', '随机', '随便', '任意角色', '任意', '随缘'];

/** 残缺指令里的**虚词**:出现这些不算"提取到了关键词"(是"随便给点"的意思)。
 * 随机标记词同样算虚词 —— 出现在修饰位就静默跳过,不往 ignored 里塞噪音。 */
const VAGUE_WORDS = new Set([
  ...RANDOM_WORDS,
  '随便的', '随机的', '啥都行', '啥图都行', '都行', '都可以',
  '来点', '发出来的', '出来的', '的出来的', '看看', '瞅瞅', '整点',
]);

/**
 * **类目词**(1.197.0 起立;1.198.0 按主人拍板补全):这些是**泛称不是角色名** ——
 * 别名表的契约是「中文角色名 → 图源 tag」,它们永远不会被登记;
 * 也不许映射图源 tag:「萝莉/幼女」类词禁入 TAG_WORDS(`MINOR_TAGS`
 * 黑名单是**前缀级** fail-closed,`lolicon`、`lolita` 都会被 `loli` 咬住,映射过去搜出来的图
 * 整批被拦,fail-closed 正是拍板的内容口径)。
 *
 * 落点 = **已拍板的随机角色机制**(1.184.0「提取不出明确关键词就随机取登记角色爬热门的」):
 * 判定在**服务层**做(别名表优先 —— 真有人把词表里的词登记成角色,具名永远赢),
 * 这里只提供词形识别的唯一一份(D159)。
 *
 * **来源与同步口径**(1.198.0,主人:「把梦境角色卡分类的类目都加上」):
 * 下面的词 = `D:\卡\角色卡\` 一级分类目录名逐个拆词(复合目录名「御姐，人妻」「百合，百破，扶她」
 * 按逗号拆开)+ 1.197.0 首批泛称;2026-10-25 清点。卡库**加分类时这张表不会自己长** ——
 * 手动同步一行即可;词表只决定"不按具名角色搜",不产生任何检索行为,加错词的代价 = 多随机一次。
 * ⚠️ `TAG_WORDS` 已有的类目词(兽耳/女仆/机娘/猫娘/天使…)**不进这里** —— 它们走 tag 检索,
 *    出的图比"随机角色"更贴词;两表是分工不是重复。词表【暂定】,主人可增删。
 */
export const CATEGORY_RANDOM_WORDS = [
  // ——— 1.197.0 首批(泛称/体型类) ———
  '萝莉', '幼女', '正太', '少女', '美少女', '妹子', '女孩子', '小姐姐',
  // ——— 1.198.0 梦境卡库一级分类(D:\卡\角色卡\,2026-10-25 清点) ———
  '假小子', '催眠', '全年龄', '同人', '后宫', '女儿', '妹妹', '开大车',
  '御姐', '人妻', '校园', '熟女', '百合', '百破', '扶她', '纯爱', '调教',
  '抽象卡', '插图卡', '整活类', '正常向',
  // ASCII 类目词(NTR 系):解析层必须在 tag 形状判断前跳过它们(见 classifyWord),
  // 否则「来点NTR图」会被当成 tag 去查询 → 图源 0 结果 → 用户扑空。
  'NTR', 'NTS', 'NTL',
];

const CATEGORY_RANDOM_SET = new Set(CATEGORY_RANDOM_WORDS);

/** 这个词是不是**类目词**(泛称)?是 → 服务层按模糊请求随机挑角色,不回「未登记」。 */
export function isCategoryRandomWord(word) {
  return CATEGORY_RANDOM_SET.has(String(word ?? '').trim());
}

/** 标签保留上限:图源查询里角色本身已经占一个位置(来源限制)。 */
const MAX_TAGS = 2;

/** 没写数字上限时的默认值。【暂定】 */
export const DEFAULT_MEITU_MAX = 5;

/** 残缺指令(没写数量)时的默认张数。【暂定】 */
export const DEFAULT_MEITU_COUNT = 1;

/** 指令动词:发/来/找/搬(发/来/找=1.179.1;搬=1.181.0,主人实测用的就是这个字)。 */
const VERBS = '发|来|找|搬';

/**
 * **指令前面最多容忍多少字的噪点**(2026-10-23 主人定的口径:「只要指令在句子里出现就认,
 * 前缀最多 ~24 字闲聊/语气词/名字」)。超过这截就不认了 —— 一条 @ 消息里隔了半句才提指令,
 * 更像闲聊而不是在下命令。【主人拍板 24;要收紧/放宽只改这一个数】
 *
 * ⚠️ 只在**开头解析失败之后**才用(见 `findNoisyStart`),正常的「发1张…」一个字符都不多花;
 * ⚠️ 只在**群里 @ 消息**这条路上用(`src\index.js` 的 `message.isMention` 闸),所以
 *    误判的代价最多是"回一句格式/没登记",不会打扰别的群聊。
 */
export const MAX_NOISE_PREFIX = 24;

/**
 * **复合词护栏**:动词前面紧挨着这些字时,它不是指令动词,是另一个词的一部分 ——
 * 这一条是"放宽"的代价里最贵的一半,不挡的话「**回**来3张图」「**头**发3张图」都会触发。
 * 表按动词分开写(同一个前置字在不同动词前不一定是词尾:例如「回」+「来」= 回来,
 * 但「回」+「发」不成立)。
 */
const COMPOUND_BEFORE = {
  来: new Set([...'回起出过本原下将看进上到后从向用换带引拿送抓夺抢争伴归']),
  发: new Set([...'头理沙蒸复散颁引爆发打开揭出越焕批播收喷挥印激']),
  找: new Set([...'寻好难']),
  搬: new Set([...'手']),
};

/** 数量:阿拉伯数字或中文数字(一~九、十、十几、几十几);1.199.0 起加「几」——
 *  单独一个「几」= 5 张(主人 2026-10-25 拍板:「发/来几张」直接判定为五张)。
 *  ⚠️ 四个正则(COMMAND/FLEX/ATTEMPT/VERB_ANYWHERE)的数量位**都引用这份字类** ——
 *  只改这一处,别在正则里手写字符类(D159:一份实现)。 */
const COUNT_CHARS = '[0-9一二两三四五六七八九十几]+';

/** 完整指令形状:动词 + 数量 + 张 + 角色 + **档位名词** + 修饰。 */
const COMMAND_RE = new RegExp(
  `^(?:${VERBS})\\s*(${COUNT_CHARS})\\s*张\\s*([^，,、;；]+?)\\s*(美图|涩图|色图|擦边图)\\s*(.*)$`,
  'u',
);

/**
 * 残缺指令形状:动词 + (数量可省) + 量词 + 剩余任意。解析器会从剩余里尽力提取。
 * 量词位 = 「张」或「点/些」(1.197.0,现场「来点萝莉图」以前连残缺指令都进不去 ——
 * 「点」不在「张」的字类里,整条 format 失败被当闲聊丢给模型;扩一个字类就接上了,
 * 后面的提取逻辑一字不动)。⚠️ `looksLikeMeituAttempt`(格式提示)**不跟着扩**:
 * 「来点乐子」这类真闲聊没有「张」,宁可走模型也不回格式提示 —— 宁窄勿宽。
 */
const FLEX_RE = new RegExp(`^(?:${VERBS})\\s*(${COUNT_CHARS})?\\s*[张点些]\\s*(.*)$`, 'u');

/** 「像这条指令」的宽松形状(只看 动词+数量+张,给格式提示用)。 */
const ATTEMPT_RE = new RegExp(`^(?:${VERBS})\\s*${COUNT_CHARS}\\s*张`, 'u');

/** 正文里任何位置的 动词+数量+张(给剥 @残留 定边界用)。
 *  ⚠️ 1.188.1 起数量可省(「来张示例甲美图」也是指令):原来必须带数量,于是
 *     「@副实例 来张示例甲美图」的 @残留剥不掉、开头解析也失败。 */
const VERB_ANYWHERE_RE = new RegExp(`(?:${VERBS})\\s*(?:${COUNT_CHARS})?\\s*张`, 'u');

/** 中文数字 → 数值。⚠️ 「几」= 5(1.199.0,主人拍板「几张」直接判五张);
 *  「十几/几十几」**不认**:split 正则的数字类不收「几」,整串落不到任何分支 →
 *  `CN_NUM['十几']` 查不到 = NaN = 格式提示(宁窄勿宽,要扩先过主人)。 */
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 几: 5 };

/** 「一/两/十/十五/二十三/几」这类中文数量词 → 数字;认不出返回 NaN。 */
function parseCount(token) {
  const raw = String(token ?? '').trim();
  if (/^\d+$/u.test(raw)) return Number.parseInt(raw, 10);
  if (!/^[一二两三四五六七八九十几]*$/u.test(raw)) return Number.NaN;
  if (raw === '') return DEFAULT_MEITU_COUNT;
  if (raw === '十') return 10;
  const split = /^([一二两三四五六七八九]?)十([一二两三四五六七八九])?$/u.exec(raw);
  if (split) return (split[1] ? CN_NUM[split[1]] : 1) * 10 + (split[2] ? CN_NUM[split[2]] : 0);
  return CN_NUM[raw] ?? Number.NaN;
}

/**
 * 剥掉正文开头残留的**纯文本 @**(`@副实例 发1张…` / `@副实例，发1张…`)。
 * 平台事件里 mention 元数据还在(@ 判定不受影响),但文本里的 @ 不是段落、网关剥不掉。
 * 做法:从 `@` 剥到**第一个 动词+数量+张** 之前 —— 名字后面带不带空格/标点都行;
 * 正文里找不到指令形状(或 @ 在动词之后)就原样返回,绝不多剥。
 */
function stripLeadingAt(text) {
  const verb = VERB_ANYWHERE_RE.exec(text);
  if (!verb) return text;
  const at = text.indexOf('@');
  if (at === -1 || at >= verb.index) return text;
  return text.slice(verb.index);
}

/**
 * 剥掉正文**末尾**残留的纯文本 @(`…美图 @副实例` / `…美图@副实例` / `…美图，@副实例`)。
 * 与 `stripLeadingAt` 对称:**只在正文里已经出现指令形状、且 @ 在指令之后**时才剥,
 * 且只剥最后一段 `@+非空白`(多个提及并列时最多连剥 3 段);前面没有指令就原样返回,绝不多剥。
 * (1.195.0:主人报「@副实例 放到指令末尾」时出现不能识别的案例 —— 例如 `来张示例甲@副实例`
 *  会把「示例甲@副实例」整段当角色名。)
 */
function stripTrailingAt(text) {
  let out = String(text ?? '').trim();
  for (let i = 0; i < 3; i += 1) {
    const tail = /[\s，,、;；。.!！?？]*@[^\s，,、;；。.!！?？]*$/u.exec(out);
    if (!tail) break;
    const verb = VERB_ANYWHERE_RE.exec(out);
    if (!verb || tail.index <= verb.index) break;
    out = out.slice(0, tail.index).trim();
  }
  return out;
}

/** 去掉「张」与「名词」之间那截的尾部修饰。 */
function stripCharacterSuffix(text) {
  let out = String(text ?? '').trim();
  // 「示例甲的图」→「示例甲」;「示例甲的」→「示例甲」。
  for (let i = 0; i < 3; i += 1) {
    if (out.endsWith('的图')) out = out.slice(0, -2).trim();
    else if (WORD_TAILS.includes(out.slice(-1))) out = out.slice(0, -1).trim();
    else break;
  }
  return out;
}

/** 去掉一个修饰词的尾巴(可连续:「泳装图的」)。 */
function stripWordSuffix(word) {
  let out = word.trim();
  while (out.length > 0 && WORD_TAILS.includes(out.slice(-1))) out = out.slice(0, -1).trim();
  return out;
}

/** 把一个词翻成 `{kind: 'tag'|'erotic'|'noun'|'skip'|'plain', tag?/tier?/word?}`。
 * ⚠️ 名词在**剥尾之前**判原词 —— 先剥尾会把「美图」剥成「美」当了角色名;
 * ⚠️ 「擦边/涩」剥尾前后都要试(「擦边的」「涩图向」都算)。 */
function classifyWord(raw) {
  const trimmed = String(raw ?? '').replace(/^(?:要|请)+/u, '').trim();
  if (!trimmed) return { kind: 'skip' };
  if (NOUN_TIERS[trimmed]) return { kind: 'noun', tier: NOUN_TIERS[trimmed], word: trimmed };
  if (trimmed === '擦边' || trimmed === '涩') return { kind: 'erotic', word: trimmed };
  const word = stripWordSuffix(trimmed);
  if (!word) return { kind: 'skip' };
  if (word === '擦边' || word === '涩') return { kind: 'erotic', word };
  for (const entry of TAG_WORDS) {
    if (entry.words.includes(word)) return { kind: 'tag', tag: entry.tag };
  }
  // 类目词(1.198.0):**不进 tags 也不当角色名**,与 VAGUE_WORDS 同为跳过 ——
  // ⚠️ 必须排在下面那行 tag 形状判断**之前**:ASCII 类目词(NTR/NTS/NTL)不加这道闸
  //    会被 `/^[a-z0-9_()]+$/i` 吃成 tag 去查询 → 图源 0 结果 → 用户扑空。
  if (CATEGORY_RANDOM_SET.has(word) || CATEGORY_RANDOM_SET.has(trimmed)) return { kind: 'skip' };
  if (/^[a-z0-9_()]+$/i.test(word)) return { kind: 'tag', tag: word };
  if (VAGUE_WORDS.has(word) || VAGUE_WORDS.has(trimmed)) return { kind: 'skip' };
  return { kind: 'plain', word };
}

/** 明确修饰区才允许有限强调前缀;去前缀后必须整词命中既有词表,不做子串搜索。
 * 复用 classifyWord/TAG_WORDS,不是新 NLP/尺寸排序;「大大大」仍是 ignored。
 * 正则的 ^ 采用 JS 输入边界断言,不匹配词中间:
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions/Input_boundary_assertion
 * asOf 2026-10-28。这里只剥一次已知前缀,否定词/未知名不猜。
 */
function emphasizedModifierOf(raw) {
  const word = stripWordSuffix(String(raw ?? '').replace(/^(?:要|请)+/u, '').trim());
  const emphasized = /^(?:最大的|最大|特别|非常|超级|很)(.+)$/u.exec(word);
  if (!emphasized) return null;
  const hit = TAG_WORDS.find((entry) => entry.words.includes(emphasized[1]));
  return hit ? { kind: 'tag', tag: hit.tag } : null;
}

function classifyModifierWord(raw) {
  const item = classifyWord(raw);
  return item.kind === 'plain' ? (emphasizedModifierOf(raw) ?? item) : item;
}

/** 这截"角色"其实是虚词吗(「随便的」「啥图都行」…)?是 = 残缺指令的随机模式。 */
function isVagueCharacter(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  return VAGUE_WORDS.has(value) || VAGUE_WORDS.has(stripWordSuffix(value));
}

/** 这一段是不是以**随机标记词**开头?是 → 返回余下(可能是粘着的修饰,可能为空);不是 → null。 */
function stripRandomMark(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  for (const word of RANDOM_WORDS) {
    if (value.startsWith(word)) return value.slice(word.length).trim();
  }
  return null;
}

/** 所有认识的**修饰叫法** → tag,按词长降序 —— 给"没有空格、粘成一串"的修饰做最长匹配。 */
const MODIFIER_LOOKUP = TAG_WORDS
  .flatMap((entry) => entry.words.map((word) => ({ word, tag: entry.tag })))
  .sort((a, b) => b.word.length - a.word.length);

/**
 * 把一串**没有分隔符**的修饰切开(「白丝双马尾」→ thighhighs + twintails)。
 * 只用在「随机」标记词后面那截(主人写法 `来N张随机<修饰>美图`);认不出的整段原样当 plain
 * 进 ignored,**不硬切** —— 切错比忽略更难查(与 D305「不硬剥」同一口径)。
 *
 * @returns {Array<{kind:'tag',tag:string}|{kind:'erotic',word:string}|{kind:'plain',word:string}>}
 */
function splitModifierRun(text) {
  const items = [];
  let rest = String(text ?? '').trim();
  const SKIP_HEADS = new Set(['的', '要', '请', ' ', '，', ',', '、', '；', ';']);
  while (rest) {
    if (SKIP_HEADS.has(rest[0])) { rest = rest.slice(1); continue; }
    if (rest.startsWith('擦边')) { items.push({ kind: 'erotic', word: '擦边' }); rest = rest.slice(2); continue; }
    if (rest[0] === '涩') { items.push({ kind: 'erotic', word: '涩' }); rest = rest.slice(1); continue; }
    const hit = MODIFIER_LOOKUP.find((pair) => rest.startsWith(pair.word));
    if (hit) { items.push({ kind: 'tag', tag: hit.tag }); rest = rest.slice(hit.word.length); continue; }
    // 类目词(1.198.0):「随机萝莉图」的「萝莉图」整段是类目,静默吞掉 —— 不当修饰也不当角色,
    // 随机标记已在前面摘掉,吞完这段 = 纯随机(与 classifyWord 的 skip 同一语义,只是词尾可带「图」)。
    if (CATEGORY_RANDOM_SET.has(rest) || CATEGORY_RANDOM_SET.has(stripWordSuffix(rest))) break;
    items.push(emphasizedModifierOf(rest) ?? { kind: 'plain', word: rest.trim() });
    break;
  }
  return items;
}

/**
 * 从词尾找一个**认出来**的修饰词(最长匹配优先),用于"角色名被修饰粘成一段"的剥离
 * (`花火裸足` → `花火` + barefoot)。整段就是修饰词时也认(剥完剩空 = 纯修饰 → 随机角色)。
 * @returns {{kind:'tag',tag:string,word:string}|{kind:'erotic',word:string}|null}
 */
function modifierSuffixOf(text) {
  const value = String(text ?? '');
  if (!value) return null;
  for (const pair of MODIFIER_LOOKUP) {
    if (value.endsWith(pair.word)) return { kind: 'tag', tag: pair.tag, word: pair.word };
  }
  // 升档词也算可剥的修饰(「花火擦边美图」)
  if (value.endsWith('擦边')) return { kind: 'erotic', word: '擦边' };
  if (value.endsWith('涩')) return { kind: 'erotic', word: '涩' };
  return null;
}

/**
 * **角色位**的候选解读(纯词法,不查别名表):从**原样**开始,逐次从词尾剥认识的修饰词。
 * 顺序 = 原样在前、剥得越多越靠后 —— 与 D305「精确命中的那条优先」同一口径:先信用户写的就是角色名。
 *   「花火裸足」→ [{花火裸足,[]}, {花火,['barefoot']}]
 *   「裸足」    → [{裸足,[]}, {'',['barefoot']}](空角色 = 纯修饰)
 *   「吹雪裸足」→ [{吹雪裸足,[]}, {吹雪,['barefoot']}, {吹,['snow','barefoot']}]
 * ⚠️ 谁是角色名**只有别名表知道** —— 这里只给候选,由 `pickCharacterSlot` 用表挑(别在这一层猜)。
 * @returns {Array<{character:string, tags:string[], erotic:boolean}>}
 */
export function characterSlotVariants(rawSlot) {
  const slot = stripCharacterSuffix(rawSlot);
  const out = [];
  let rest = slot;
  const peeled = []; // 从右往左剥出来的项;输出时反成原文顺序
  for (;;) {
    const tags = [];
    for (const item of [...peeled].reverse()) {
      if (item.kind === 'tag' && !tags.includes(item.tag)) tags.push(item.tag);
    }
    out.push({ character: rest, tags, erotic: peeled.some((item) => item.kind === 'erotic') });
    if (!rest) break;
    const hit = modifierSuffixOf(rest);
    if (!hit) break;
    peeled.push(hit);
    rest = rest.slice(0, rest.length - hit.word.length);
  }
  return out;
}

/**
 * 用"名字登记没登记"从候选里挑一个解读(1.191.0,主人报「来两张花火裸足美图」被整段当角色名)。
 * 顺序:**原样优先**(写的就是角色名就别乱剥),再逐级剥词尾修饰
 * (`花火裸足`→花火+裸足;`吹雪裸足`→吹雪+裸足;`吹雪`→原样,雪不剥)。
 * 全都登记不上但能剥成**纯修饰**(`裸足美图`)→ `random: true`(随机角色 + 那些修饰)。
 * 都不成立 → 原样返回(上层照常回「没登记」)。
 *
 * @param {string} rawSlot 角色位原文
 * @param {(name: string) => boolean} isKnown 名字是否登记过(`resolveCharacterTag(name, aliases).ok`)
 * @returns {{character:string, tags:string[], erotic:boolean, random:boolean}}
 */
export function pickCharacterSlot(rawSlot, isKnown) {
  const variants = characterSlotVariants(rawSlot);
  const known = typeof isKnown === 'function' ? isKnown : () => false;
  for (const variant of variants) {
    if (variant.character && known(variant.character)) return { ...variant, random: false };
  }
  const bare = variants.find(
    (variant) => variant.character === '' && (variant.tags.length > 0 || variant.erotic),
  );
  if (bare) return { ...bare, random: true };
  return { character: variants[0]?.character ?? '', tags: [], erotic: false, random: false };
}

/**
 * 角色位剥离结果 + 解析器的修饰 → 最终 `{tags, tier}`。
 * 上限与升档口径只有这一份(D159):角色位剥出来的修饰排在**前面**(原文里它们在名词之前)。
 *
 * @param {{tags?: string[], tier?: string}} parsed
 * @param {{tags?: string[], erotic?: boolean}|null} slotPick
 */
export function applyCharacterSlot(parsed, slotPick) {
  const merged = [];
  for (const tag of [...(slotPick?.tags ?? []), ...(parsed?.tags ?? [])]) {
    if (!merged.includes(tag)) merged.push(tag);
  }
  return {
    tags: merged.slice(0, MAX_TAGS),
    tier: slotPick?.erotic ? 'seitu' : (parsed?.tier ?? 'meitu'),
  };
}

/**
 * 把修饰段(以及**预先归类好的**项)收口成 `{tags, erotic, ignored}`。
 * 标签**按出现顺序去重**,超过 2 个的部分进 ignored(不是悄悄丢掉 —— 日志里要看得见)。
 *
 * @param {string} text 修饰正文(按标点/空白切词)
 * @param {Array<object>} [lead] 已经归类好的项,排在正文**之前**(「随机」后面粘着的那串)
 */
function parseModifiers(text, lead = []) {
  const tags = [];
  const ignored = [];
  let erotic = false;
  const items = Array.isArray(lead) ? [...lead] : [];
  const body = String(text ?? '').trim().replace(/^(?:要|请)+/u, '');
  if (body !== '') {
    for (const chunk of body.split(/[，,、;；\s]+/u)) items.push(classifyModifierWord(chunk));
  }
  for (const item of items) {
    if (item.kind === 'skip') continue;
    if (item.kind === 'erotic') { erotic = true; continue; }
    if (item.kind === 'tag') {
      if (!tags.includes(item.tag)) tags.push(item.tag);
      continue;
    }
    ignored.push(item.word);
  }
  const kept = tags.slice(0, MAX_TAGS);
  for (const extra of tags.slice(MAX_TAGS)) ignored.push(extra);
  return { tags: kept, erotic, ignored };
}

/**
 * 从残缺指令的一段里剥出**粘在词尾的档位名词**
 * (「示例甲美图」→ 头 `示例甲` + 档位 meitu;整段就是「涩图」→ 头空 + seitu)。
 * 名词后面只允许再跟「的/图/向/级/片」这类尾巴(「示例甲美图的」);
 * 后面跟着别的字(「示例甲美图足控」)说明不是后缀,不剥 —— 宁可保持原行为也别猜。
 *
 * @returns {{head: string, tier: 'meitu'|'seitu'}|null}
 */
function peelTierNoun(chunk) {
  let best = null;
  for (const [noun, tier] of Object.entries(NOUN_TIERS)) {
    const at = chunk.lastIndexOf(noun);
    if (at === -1) continue;
    const tail = chunk.slice(at + noun.length);
    if (![...tail].every((ch) => WORD_TAILS.includes(ch))) continue;
    const end = at + noun.length;
    if (!best || end > best.end) best = { head: chunk.slice(0, at), tier, end };
  }
  return best;
}

/**
 * 残缺指令:从剩余段里**尽力提取**(名词定档、修饰进 tags、第一个实词当角色)。
 * 什么都提取不出来 → `random: true`(服务层从别名表随机挑角色)。
 */
function parseFlexRest(rest) {
  const tags = [];
  const ignored = [];
  let tier = 'meitu';
  let character = '';
  // 角色只在尚未进入明确修饰区时取第一个实词;关闭后不再被未知修饰重新打开。
  let characterSlotOpen = true;

  /** 归类一项(名词定档 / 擦边升档 / 修饰进 tags / 角色槽实词 / 其余 ignored)。 */
  const applyItem = (item) => {
    if (item.kind === 'skip') return;
    if (item.kind === 'noun') { tier = item.tier; return; }
    if (item.kind === 'erotic') { tier = 'seitu'; return; }
    if (item.kind === 'tag') {
      if (!tags.includes(item.tag)) tags.push(item.tag);
      return;
    }
    if (characterSlotOpen && !character) { character = item.word; characterSlotOpen = false; return; }
    ignored.push(item.word);
  };

  /** 吃掉一段:先剥词尾档位名词,再认开头的**随机标记词**,剩下才是普通词。 */
  const take = (chunk) => {
    if (/^(?:要|请)/u.test(chunk)) characterSlotOpen = false;
    let word = chunk;
    const peeled = peelTierNoun(chunk);
    if (peeled) {
      tier = peeled.tier;
      word = peeled.head;
      if (!word) return;
    }
    const randomRest = stripRandomMark(word);
    if (randomRest !== null) {
      // 随机标记:余下都是修饰(可能粘成一串),plain 也只进 ignored。
      characterSlotOpen = false;
      for (const item of splitModifierRun(randomRest)) applyItem(item);
      return;
    }
    // 类目只认完整 chunk(含既有尾巴剥除),不把「熟女仙子」之类未知名吞成随机。
    if (CATEGORY_RANDOM_SET.has(word) || CATEGORY_RANDOM_SET.has(stripWordSuffix(word))) {
      characterSlotOpen = false;
    }
    applyItem(characterSlotOpen ? classifyWord(word) : classifyModifierWord(word));
  };

  // 保留分隔符,只有明确标点关闭角色槽;普通空格仍沿用旧的逐词解析。
  for (const chunk of String(rest ?? '').split(/([，,、;；\s]+)/u)) {
    if (!chunk) continue;
    if (/^[，,、;；\s]+$/u.test(chunk)) {
      if (/[，,、;；]/u.test(chunk)) characterSlotOpen = false;
    } else take(chunk);
  }
  const kept = tags.slice(0, MAX_TAGS);
  for (const extra of tags.slice(MAX_TAGS)) ignored.push(extra);
  return { tier, character: stripCharacterSuffix(character), tags: kept, ignored };
}

/** 一次成功解析的公共尾巴(数量夹到调用方给的上限)。
 * `tier` 是唯一档位字段:meitu=全年龄唯美,seitu=擦边(「涩图」名词或「擦边/涩」修饰都归它)。 */
function buildParsed({ count, tier, character, tags, ignored, random, max = DEFAULT_MEITU_MAX }) {
  const limit = Number.isSafeInteger(max) && max > 0 ? max : DEFAULT_MEITU_MAX;
  return {
    ok: true,
    count: Math.min(count, limit),
    character,
    tags,
    ratingWanted: true,
    tier,
    random,
    ignored,
  };
}

/**
 * 解析一条群消息(已经剥掉段落 @)。成功 = 可以照做;失败 = 不是这条指令。
 *
 * @param {string} text 消息正文
 * @param {{max?: number}} [options] `max` = 一次最多几张(来自 `config.meitu.max`)
 * @returns {{ok: true, count: number, character: string, tags: string[], ratingWanted: boolean,
 *            tier: 'meitu'|'seitu', random: boolean, ignored: string[]}
 *   | {ok: false, reason: 'format'|'count'|'character'}}
 *   `tier` = 检索档位(美图=全年龄唯美;涩图=擦边);
 *   `random: true` = 没指定角色(残缺指令 / 角色位写「随机」)—— 服务层从别名表随机挑一个,
 *   挑中的中文名照旧决定落盘目录与图库分类。
 */
export function parseMeituCommand(text, { max = DEFAULT_MEITU_MAX } = {}) {
  const normalized = stripLeadingAt(
    stripTrailingAt(
      String(text ?? '')
        .trim()
        .replace(/^[，,、\s]+/u, '')
        .replace(/[。！!]+$/u, '')
        .trim(),
    ),
  );

  // ① 指令就在开头(绝大多数写法走这一条,行为与 1.188.0 完全一致)。
  const direct = parseFromStart(normalized, max);
  if (direct) return direct;

  // ② 开头有噪点(「再来五张…」「嗯…那就来两张…」):在前 MAX_NOISE_PREFIX 字里找指令起点。
  //    ⚠️ 这是**放宽**,不是新指令 —— 找到起点之后仍走 ① 的同一套解析(一个字段都不另算)。
  const noisy = parseAfterNoise(normalized, max);
  if (noisy) return noisy;

  return { ok: false, reason: 'format' };
}

/**
 * 从文本**开头**按指令解析(完整指令 → 残缺指令)。
 *
 * @returns {ReturnType<typeof buildParsed>|{ok: false, reason: 'count'}|null}
 *   `null` = 开头根本不是这条指令的形状(可以继续往后找);
 *   `{ok:false, reason:'count'}` = **确实在写这条指令**,但数量写坏了(0 张/非法)——
 *   这是"确定失败",不许再往后找别的起点(否则「来0张美图」会被下一个候选词救回来)。
 */
function parseFromStart(normalized, max) {
  // ① 完整指令:动词 + 数量 + 张 + 角色 + 名词 + 修饰。
  const full = COMMAND_RE.exec(normalized);
  // 角色捕获不能跨显式标点(由 COMMAND_RE 保证),也不能吞掉另起的「要/请」修饰。
  // 仅另起的引导词走 flex;名字本身可能以「要/请」起头(如要乐奈)，不能只凭首字吞名。
  if (full && !/^(?:要|请)\s+|\s+(?:要|请)/u.test(full[2])) {
    const count = parseCount(full[1]);
    // 0 张 = 让人别发?没有这种语义,当**写错了**回格式话。
    if (!Number.isSafeInteger(count) || count <= 0) return { ok: false, reason: 'count' };
    const character = stripCharacterSuffix(full[2]);
    // 角色位是空格/虚词(「发1张美图」「来2张随便的涩图」)→ **随机模式**,不许把
    // 「随便」当角色名去查别名表。完整指令的分支里不再产生 character 失败。
    // 1.184.0:「随机」标记词后面**粘着**的那截是修饰(「随机双马尾美图」),按认识的词切开。
    const randomRest = stripRandomMark(character);
    const vague = randomRest !== null || character === '' || isVagueCharacter(character);
    const modifiers = parseModifiers(full[4], randomRest ? splitModifierRun(randomRest) : []);
    // 写「美图」但修饰里带「擦边/涩」→ 升涩图档(1.179.x 老写法「…美图，要擦边的」兼容)。
    const tier = NOUN_TIERS[full[3]] === 'seitu' || modifiers.erotic ? 'seitu' : 'meitu';
    return buildParsed({
      count,
      tier,
      character: vague ? '' : character,
      tags: modifiers.tags,
      ignored: modifiers.ignored,
      random: vague,
      max,
    });
  }

  // ② 残缺指令:动词 + (数量可省) + 张,剩余段尽力提取;提取不到角色 = 随机。
  const flex = FLEX_RE.exec(normalized);
  if (flex) {
    const count = parseCount(flex[1]);
    if (!Number.isSafeInteger(count) || count <= 0) return { ok: false, reason: 'count' };
    const rest = parseFlexRest(flex[2]);
    return buildParsed({
      count,
      tier: rest.tier,
      character: rest.character,
      tags: rest.tags,
      ignored: rest.ignored,
      random: rest.character === '',
      max,
    });
  }

  return null;
}

/**
 * **前缀噪点**里的指令起点:在文本前 `MAX_NOISE_PREFIX` 字里从左往右找「发/来/找/搬」,
 * 逐字节从那里往下按 `parseFromStart` 的同一套规则解析 —— 能解析出来的第一个就是它。
 *
 * 两条护栏:
 *   · **复合词护栏**(`COMPOUND_BEFORE`):「回来3张」「头发3张」「寻找2张」里的动词只是词尾,不是指令;
 *   · 起点的**下标上限** = `MAX_NOISE_PREFIX`:隔得太远就不认(那更像闲聊里顺嘴提了一句)。
 *
 * @returns {ReturnType<typeof parseFromStart>} 没有 = null。
 */
function parseAfterNoise(normalized, max) {
  const source = String(normalized ?? '');
  const verbs = '发来找搬';
  for (let index = 1; index < source.length && index <= MAX_NOISE_PREFIX; index += 1) {
    const ch = source[index];
    if (!verbs.includes(ch)) continue;
    if (COMPOUND_BEFORE[ch]?.has(source[index - 1])) continue;
    const parsed = parseFromStart(source.slice(index).trim(), max);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * 「看起来是在尝试发美图」—— 用来区分"格式写歪了"与"普通闲聊"。
 *
 * 只认 `发/来/找/搬 N张` **开头**(剥完 @残留之后):写成 `发1张示例甲图片`(名词写歪)
 * 这类也回一句格式提示;`画一张美图给我看看` 这种随口一说**开头就不对**,不拦。
 * (残缺指令「来3张随便的」现在会被 `parseMeituCommand` 直接接走,**到不了这里**。)
 * ⚠️ 1.188.1 起 `parseMeituCommand` 会宽到"指令在句子里出现就认",但这条**只给格式提示用**、
 *    仍只看开头 —— 前面带噪点的那种已经解析成功了,轮不到格式提示。
 *
 * @param {string} text
 */
export function looksLikeMeituAttempt(text) {
  const normalized = String(text ?? '')
    .trim()
    .replace(/^[，,、\s]+/u, '');
  return ATTEMPT_RE.test(stripLeadingAt(normalized));
}
