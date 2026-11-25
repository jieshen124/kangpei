'use strict';
// 业务静态数据：区域、时段、量表工具箱、70 项病种目录、主诉选项
// 由 server.js 抽取，勿在此处写逻辑

const AREAS = [
  '东城区', '西城区', '朝阳区', '海淀区', '丰台区', '石景山区',
  '通州区', '昌平区', '大兴区', '顺义区', '房山区', '门头沟区',
  '平谷区', '怀柔区', '密云区', '延庆区',
];

const SLOTS = [
  { id: 'am', label: '上午 09:00–11:00' },
  { id: 'pm', label: '下午 14:00–16:00' },
  { id: 'ev', label: '晚间 19:00–21:00' },
];

const FOCUS = ['关节活动度训练', '肌力训练', '平衡与步态', '心肺耐力', '日常生活能力', '术后恢复训练'];

/* ------------------------------------------------------ 卒中量表工具箱 */
const o = (v, l) => ({ v, l });

const BARTHEL_OPTS = {
  a: [o(0, '完全依赖'), o(5, '需部分帮助'), o(10, '完全独立')],          // 进食/穿衣/如厕
  b: [o(0, '完全依赖'), o(5, '完全独立')],                                // 洗澡/修饰
  c: [o(0, '完全失禁'), o(5, '偶尔失禁'), o(10, '能控制')],              // 大便/小便
  d: [o(0, '完全依赖'), o(5, '需大量帮助'), o(10, '需少量帮助'), o(15, '完全独立')], // 转移/行走
  e: [o(0, '不能'), o(5, '需帮助'), o(10, '完全独立')],                  // 上下楼梯
};

const MOTOR_OPTS = [o(1, 'Ⅰ 无随意运动'), o(2, 'Ⅱ 出现联合反应'), o(3, 'Ⅲ 共同运动'), o(4, 'Ⅳ 分离运动'), o(5, 'Ⅴ 分离运动完善'), o(6, 'Ⅵ 接近正常')];

const BERG_OPTS = [o(0, '不能完成'), o(1, '需大量帮助'), o(2, '需中等帮助'), o(3, '需少量帮助'), o(4, '独立完成')];

const TOOLBOX = [
  {
    key: 'barthel', name: 'Barthel 指数', short: '自理能力', desc: '10 项日常生活能力，满分 100 分', score: 'sum', totalMax: 100,
    items: [
      { k: 'feeding', label: '进食', opts: BARTHEL_OPTS.a },
      { k: 'bathing', label: '洗澡', opts: BARTHEL_OPTS.b },
      { k: 'grooming', label: '修饰（洗脸刷牙）', opts: BARTHEL_OPTS.b },
      { k: 'dressing', label: '穿衣', opts: BARTHEL_OPTS.a },
      { k: 'bowel', label: '控制大便', opts: BARTHEL_OPTS.c },
      { k: 'bladder', label: '控制小便', opts: BARTHEL_OPTS.c },
      { k: 'toilet', label: '如厕', opts: BARTHEL_OPTS.a },
      { k: 'transfer', label: '床椅转移', opts: BARTHEL_OPTS.d },
      { k: 'walking', label: '平地行走', opts: BARTHEL_OPTS.d },
      { k: 'stairs', label: '上下楼梯', opts: BARTHEL_OPTS.e },
    ],
  },
  {
    key: 'mrs', name: 'mRS 改良 Rankin 量表', short: '残障分级', desc: '0-6 分，越低越好', score: 'sum', totalMax: 6,
    items: [{
      k: 'level', label: '当前残障等级',
      opts: [o(0, '0 完全无症状'), o(1, '1 无明显残障，能完成日常'), o(2, '2 轻度残障，不能完成原有活动'),
        o(3, '3 中度残障，可独立行走'), o(4, '4 中重度残障，行走需帮助'), o(5, '5 重度残障，卧床/失禁'),
        o(6, '6 死亡')],
    }],
  },
  {
    key: 'brunnstrom', name: 'Brunnstrom 分期', short: '偏瘫运动恢复', desc: 'Ⅰ-Ⅵ 期，按上肢/手/下肢分别记录', score: 'none',
    items: [
      { k: 'upper', label: '上肢', opts: MOTOR_OPTS },
      { k: 'hand', label: '手', opts: MOTOR_OPTS },
      { k: 'lower', label: '下肢', opts: MOTOR_OPTS },
    ],
  },
  {
    key: 'berg', name: 'Berg 平衡量表', short: '平衡', desc: '14 项，满分 56 分，需现场看护下完成', score: 'sum', totalMax: 56,
    items: [
      { k: 'sit2stand', label: '从坐到站', opts: BERG_OPTS },
      { k: 'stand_unsup', label: '无支撑站立', opts: BERG_OPTS },
      { k: 'sit_unsup', label: '无支撑坐位', opts: BERG_OPTS },
      { k: 'stand2sit', label: '从站到坐', opts: BERG_OPTS },
      { k: 'transfer', label: '床椅转移', opts: BERG_OPTS },
      { k: 'stand_eyes', label: '闭眼站立', opts: BERG_OPTS },
      { k: 'stand_feet', label: '双足并拢站立', opts: BERG_OPTS },
      { k: 'reach', label: '站立位上肢前伸', opts: BERG_OPTS },
      { k: 'pickup', label: '站立位从地上拾物', opts: BERG_OPTS },
      { k: 'turn_head', label: '转身向后看', opts: BERG_OPTS },
      { k: 'turn360', label: '360° 转身', opts: BERG_OPTS },
      { k: 'stool', label: '踏凳（单足踏台阶）', opts: BERG_OPTS },
      { k: 'tandem', label: '双足前后站立', opts: BERG_OPTS },
      { k: 'one_leg', label: '单腿站立', opts: BERG_OPTS },
    ],
  },
  {
    key: 'holden', name: 'Holden 步行能力分级', short: '步行', desc: '0-5 级', score: 'sum', totalMax: 5,
    items: [{
      k: 'level', label: '步行能力',
      opts: [o(0, '0 不能步行（需轮椅）'), o(1, '1 室内需辅助步行'), o(2, '2 室内独立步行'),
        o(3, '3 监护下步行'), o(4, '4 平地独立步行'), o(5, '5 独立步行，可上下台阶')],
    }],
  },
  {
    key: 'ashworth', name: '改良 Ashworth 肌张力', short: '肌张力', desc: '按肌群记录 0-4 级', score: 'none',
    items: [
      { k: 'elbow_flex', label: '屈肘肌群', opts: [o(0, '0 无增高'), o(1, '1 轻微增高'), o(2, '2 明显增高'), o(3, '3 显著增高'), o(4, '4 僵硬')] },
      { k: 'elbow_ext', label: '伸肘肌群', opts: [o(0, '0 无增高'), o(1, '1 轻微增高'), o(2, '2 明显增高'), o(3, '3 显著增高'), o(4, '4 僵硬')] },
      { k: 'wrist', label: '腕屈肌群', opts: [o(0, '0 无增高'), o(1, '1 轻微增高'), o(2, '2 明显增高'), o(3, '3 显著增高'), o(4, '4 僵硬')] },
      { k: 'knee', label: '屈膝肌群', opts: [o(0, '0 无增高'), o(1, '1 轻微增高'), o(2, '2 明显增高'), o(3, '3 显著增高'), o(4, '4 僵硬')] },
      { k: 'ankle', label: '踝跖屈肌群', opts: [o(0, '0 无增高'), o(1, '1 轻微增高'), o(2, '2 明显增高'), o(3, '3 显著增高'), o(4, '4 僵硬')] },
    ],
  },
  {
    key: 'phq9', name: 'PHQ-9 情绪量表', short: '情绪', desc: '9 项，满分 27 分，≥10 分提示需关注', score: 'sum', totalMax: 27,
    items: [
      { k: 'q1', label: '做事提不起兴趣', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q2', label: '感到心情低落', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q3', label: '入睡困难或睡不醒', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q4', label: '感到疲倦、没力气', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q5', label: '食欲差或暴食', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q6', label: '自我评价低', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q7', label: '注意力不集中', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q8', label: '动作或说话迟缓/烦躁', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q9', label: '有自伤念头', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
    ],
  },
];

const SCALE_BY_KEY = TOOLBOX.reduce((acc, s) => { acc[s.key] = s; return acc; }, {});

const STROKE_TYPES = ['缺血性（脑梗）', '出血性（脑出血/蛛网膜下腔）', '未明确'];
const STROKE_SIDES = ['左侧偏瘫', '右侧偏瘫', '双侧', '无明显偏瘫'];
const DEFICITS = ['失语', '构音障碍', '吞咽困难', '认知障碍', '情绪低落', '肩痛', '足下垂', '平衡障碍', '感觉障碍'];

// 病种目录（按系统/部位分组，覆盖居家康复常见情形）
const CONDITIONS = [
  {
    group: '神经系统',
    items: [
      '脑卒中（脑梗）', '脑出血', '脑外伤术后', '脑肿瘤术后',
      '脊髓损伤（颈段）', '脊髓损伤（胸腰段）',
      '帕金森病', '帕金森综合征 / 多系统萎缩',
      '多发性硬化', '格林-巴利综合征恢复期',
      '周围性面瘫（面神经炎）', '小脑共济失调',
      '认知障碍 / 痴呆', '脊髓灰质炎后遗症',
      '臂丛神经损伤', '桡神经 / 尺神经损伤', '坐骨神经损伤',
    ],
  },
  {
    group: '骨与关节',
    items: [
      '髋关节置换术后', '膝关节置换术后', '肩关节置换术后',
      '股骨颈 / 粗隆间骨折术后', '四肢骨折术后', '骨盆骨折术后',
      '脊柱骨折 / 椎体压缩骨折',
      '腰椎间盘突出', '腰椎管狭窄 / 腰椎术后', '颈椎病 / 颈椎术后',
      '肩袖损伤', '肩周炎（冻结肩）',
      '网球肘 / 高尔夫球肘', '腕管综合征 / 腱鞘炎',
      '膝骨关节炎', '类风湿关节炎', '强直性脊柱炎',
      '半月板 / 交叉韧带术后', '跟腱断裂术后', '足底筋膜炎 / 拇外翻术后',
      '手外伤 / 肌腱修复术后', '截肢术后（假肢适配）',
      '烧伤后瘢痕与关节挛缩',
    ],
  },
  {
    group: '心肺',
    items: [
      '冠心病 / 支架术后', '冠脉搭桥术后', '心衰稳定期',
      '心脏起搏器 / 除颤器植入后',
      '慢阻肺（COPD）', '肺纤维化', '肺部感染后 / 术后肺康复',
      '支气管扩张', '长期卧床脱机困难',
    ],
  },
  {
    group: '内科与代谢',
    items: [
      '糖尿病周围神经病变', '糖尿病足（创面愈合期）', '透析患者运动康复',
      '肿瘤术后 / 放化疗后康复', '癌性疲乏', '重症后综合征（ICU 后）',
      '长期卧床 / 失用综合征', '贫血 / 营养不良性衰弱',
      '带状疱疹后神经痛', '感染后疲乏',
    ],
  },
  {
    group: '老年与功能衰退',
    items: [
      '老年衰弱 / 跌倒高风险', '失能老人日常照护',
      '吞咽障碍（老年）', '尿失禁 / 盆底功能训练', '骨质疏松（运动管理）',
    ],
  },
  {
    group: '儿童',
    items: ['脑瘫（儿童）', '发育迟缓', '脊柱侧弯', '先天性肌性斜颈', '臂丛神经产伤'],
  },
  {
    group: '其他',
    items: ['其他（在备注里说明）'],
  },
];
const CONDITION_FLAT = CONDITIONS.reduce((a, g) => a.concat(g.items), []);

// 病种对应的默认流程：0/1/2/3 为 Brunnstrom 分期，o 骨科，c 心肺，n 神经，g 通用
const GROUP_PROGRAM = {
  '神经系统': 'n', '骨与关节': 'o', '心肺': 'c',
  '内科与代谢': 'g', '老年与功能衰退': 'g', '儿童': 'n', '其他': 'g',
};
const CONDITION_PROGRAM = {};
CONDITIONS.forEach((g) => g.items.forEach((it) => { CONDITION_PROGRAM[it] = GROUP_PROGRAM[g.group] || 'g'; }));
// 偏瘫相关走 Brunnstrom
['脑卒中（脑梗）', '脑出血', '脑外伤术后', '脑肿瘤术后'].forEach((c) => { CONDITION_PROGRAM[c] = '0'; });
// 个别病种单独归口
CONDITION_PROGRAM['糖尿病周围神经病变'] = 'n';
CONDITION_PROGRAM['糖尿病足（创面愈合期）'] = 'o';
CONDITION_PROGRAM['长期卧床 / 失用综合征'] = 'n';
CONDITION_PROGRAM['重症后综合征（ICU 后）'] = 'c';
CONDITION_PROGRAM['带状疱疹后神经痛'] = 'g';

// 只有这些偏瘫相关病种才适合 Brunnstrom 分期流程
const BRUNNSTROM_CONDITIONS = ['脑卒中（脑梗）', '脑出血', '脑外伤术后', '脑肿瘤术后'];
const NEURO_CONDITIONS = ['脑卒中（脑梗）', '脑出血', '脑外伤术后', '脑肿瘤术后', '脊髓损伤（颈段）', '脊髓损伤（胸腰段）', '帕金森病', '帕金森综合征 / 多系统萎缩', '多发性硬化'];

// 主诉目录：用患者自己的话，不用专业术语
const CONCERNS = [
  '走路不稳、容易摔',
  '一侧胳膊抬不起来',
  '手指抓不住东西、扣不上扣子',
  '说话不清楚',
  '吃饭容易呛、吞咽费劲',
  '肩膀疼、夜里疼醒',
  '腿没劲、站不了多久',
  '上下楼梯费劲',
  '穿衣洗澡要人帮',
  '上厕所不方便',
  '手脚肿',
  '一动就喘、容易累',
  '睡不好、情绪低落',
  '记性差、容易忘事',
  '腰背疼、坐不住',
];

module.exports = {
  AREAS, SLOTS, FOCUS, BARTHEL_OPTS, MOTOR_OPTS, BERG_OPTS,
  TOOLBOX, SCALE_BY_KEY, STROKE_TYPES, STROKE_SIDES, DEFICITS,
  CONDITIONS, CONDITION_FLAT, GROUP_PROGRAM, CONDITION_PROGRAM,
  BRUNNSTROM_CONDITIONS, NEURO_CONDITIONS, CONCERNS,
};
