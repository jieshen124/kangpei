import json
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.enum.table import WD_ALIGN_VERTICAL
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

FLOWS = json.load(open('/tmp/rv/flows.json', encoding='utf-8'))
CAT = json.load(open('/tmp/rv/catalog.json', encoding='utf-8'))
INC = json.load(open('/tmp/rv/incidents.json', encoding='utf-8'))

OUT = '/home/user/Doubao/chats/38454505134134530/居家康复陪练流程_临床审阅稿_v0.9.docx'

doc = Document()

# ---------- 页面 ----------
sec = doc.sections[0]
sec.page_width = Cm(21)
sec.page_height = Cm(29.7)
for attr in ('top_margin', 'bottom_margin', 'left_margin', 'right_margin'):
    setattr(sec, attr, Cm(2.5))
sec.different_first_page_header_footer = True


def cn_font(run, cn='宋体', en='Times New Roman', size=12, bold=False):
    run.font.name = en
    run.font.size = Pt(size)
    run.bold = bold
    run.font.color.rgb = RGBColor(0, 0, 0)
    rpr = run._element.get_or_add_rPr()
    rf = rpr.find(qn('w:rFonts'))
    if rf is None:
        rf = OxmlElement('w:rFonts')
        rpr.append(rf)
    rf.set(qn('w:ascii'), en)
    rf.set(qn('w:hAnsi'), en)
    rf.set(qn('w:eastAsia'), cn)


def style_font(style, cn='宋体', size=12, bold=False):
    en = 'Times New Roman'
    style.font.name = en
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor(0, 0, 0)
    rpr = style.element.get_or_add_rPr()
    rf = rpr.find(qn('w:rFonts'))
    if rf is None:
        rf = OxmlElement('w:rFonts')
        rpr.append(rf)
    rf.set(qn('w:ascii'), en)
    rf.set(qn('w:hAnsi'), en)
    rf.set(qn('w:eastAsia'), cn)


# Normal
normal = doc.styles['Normal']
style_font(normal, '宋体', 12)
pf = normal.paragraph_format
pf.line_spacing = 1.5
pf.first_line_indent = Pt(24)
pf.space_before = Pt(0)
pf.space_after = Pt(0)
pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

for name, cn, size, before, after in (
    ('Heading 1', '黑体', 16, 14, 6),
    ('Heading 2', '黑体', 14, 11, 5),
    ('Heading 3', '黑体', 12, 9, 4),
):
    st = doc.styles[name]
    style_font(st, cn, size=size, bold=True)
    st.paragraph_format.space_before = Pt(before)
    st.paragraph_format.space_after = Pt(after)
    st.paragraph_format.first_line_indent = Pt(0)
    st.paragraph_format.keep_with_next = True
    st.paragraph_format.line_spacing = 1.5

# Title / Subtitle 自定义样式
for sname, cn, size, bold in (('Title', '黑体', 18, True), ('Subtitle', '楷体', 12, False)):
    try:
        st = doc.styles[sname]
    except KeyError:
        from docx.enum.style import WD_STYLE_TYPE
        st = doc.styles.add_style(sname, WD_STYLE_TYPE.PARAGRAPH)
    style_font(st, cn, size=size, bold=bold)
    st.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    st.paragraph_format.first_line_indent = Pt(0)


def body(text, indent=True, space_after=0):
    p = doc.add_paragraph()
    p.paragraph_format.first_line_indent = Pt(24) if indent else Pt(0)
    p.paragraph_format.space_after = Pt(space_after)
    r = p.add_run(text)
    cn_font(r, '宋体', size=12)
    return p


def h1(text):
    return doc.add_paragraph(text, style='Heading 1')


def h2(text):
    return doc.add_paragraph(text, style='Heading 2')


def caption(text, before=6):
    p = doc.add_paragraph()
    p.paragraph_format.first_line_indent = Pt(0)
    p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(before)
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.keep_with_next = True
    r = p.add_run(text)
    cn_font(r, '宋体', size=10.5)
    return p


def shade(cell, color='F2F2F2'):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), color)
    tcPr.append(shd)


def row_flags(row, header=False):
    trPr = row._tr.get_or_add_trPr()
    cs = OxmlElement('w:cantSplit')
    trPr.append(cs)
    if header:
        th = OxmlElement('w:tblHeader')
        trPr.append(th)


def write_cell(cell, lines, size=10.5, align=WD_ALIGN_PARAGRAPH.LEFT, bold=False):
    cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
    cell.text = ''
    p0 = cell.paragraphs[0]
    for i, line in enumerate(lines):
        p = p0 if i == 0 else cell.add_paragraph()
        p.paragraph_format.first_line_indent = Pt(0)
        p.paragraph_format.left_indent = Pt(0)
        p.paragraph_format.right_indent = Pt(0)
        p.paragraph_format.space_before = Pt(1)
        p.paragraph_format.space_after = Pt(1)
        p.paragraph_format.line_spacing = 1.15
        p.alignment = align
        r = p.add_run(line)
        cn_font(r, '宋体', size=size, bold=bold)


def add_table(head, rows, widths, header_align=WD_ALIGN_PARAGRAPH.CENTER, group_rows=()):
    t = doc.add_table(rows=1, cols=len(head))
    t.style = 'Table Grid'
    t.autofit = False
    hdr = t.rows[0]
    row_flags(hdr, header=True)
    for i, (cell, txt) in enumerate(zip(hdr.cells, head)):
        cell.width = Cm(widths[i])
        shade(cell)
        write_cell(cell, [txt], align=header_align, bold=True)
    for ri, r in enumerate(rows):
        row = t.add_row()
        row_flags(row)
        is_group = ri in group_rows
        for i, cell in enumerate(row.cells):
            cell.width = Cm(widths[i])
            if is_group:
                shade(cell, 'F7F7F7')
            val = r[i]
            if isinstance(val, str):
                val = [val]
            write_cell(cell, val, bold=is_group)
    return t


def para_no_indent(text, size=12, bold=False, after=6):
    p = doc.add_paragraph()
    p.paragraph_format.first_line_indent = Pt(0)
    p.paragraph_format.space_after = Pt(after)
    r = p.add_run(text)
    cn_font(r, '宋体', size=size, bold=bold)
    return p


# ---------- 封面 ----------
p = doc.add_paragraph('', style='Title')
p.paragraph_format.space_before = Pt(90)
p.paragraph_format.space_after = Pt(18)
r = p.add_run('居家康复陪练流程临床审阅稿')
cn_font(r, '黑体', size=18, bold=True)

p = doc.add_paragraph('', style='Subtitle')
p.paragraph_format.space_after = Pt(30)
r = p.add_run('面向康复医师与康复治疗师：流程安全性、禁忌与阈值审阅')
cn_font(r, '楷体', size=12)

info = [
    ('文档用途', '请审阅八套陪练流程的动作安全性、阈值设定、异常识别与边界措辞'),
    ('版本', 'v0.9（首版审阅稿，未上线用于真实患者）'),
    ('编制日期', '2026 年 11 月 19 日'),
    ('覆盖范围', '8 套流程、70 个病种、9 类现场异常指引'),
    ('建议审阅用时', '40 至 60 分钟'),
    ('反馈方式', '在第十部分逐条勾选判断，或直接在正文批注'),
]
t = doc.add_table(rows=0, cols=2)
t.style = 'Table Grid'
t.autofit = False
for k, v in info:
    row = t.add_row()
    row_flags(row)
    row.cells[0].width = Cm(4.0)
    row.cells[1].width = Cm(11.0)
    write_cell(row.cells[0], [k], size=10.5, bold=True)
    write_cell(row.cells[1], [v], size=10.5)

p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(36)
p.paragraph_format.first_line_indent = Pt(0)
p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run('本稿为原型阶段内部审阅材料，审阅通过前不得用于任何真实患者场景。')
cn_font(r, '楷体', size=10.5)

doc.add_page_break()

# ---------- 目录 ----------
p = doc.add_paragraph()
p.paragraph_format.first_line_indent = Pt(0)
p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_after = Pt(12)
r = p.add_run('目　录')
cn_font(r, '黑体', size=16, bold=True)

tocp = doc.add_paragraph()
tocp.paragraph_format.first_line_indent = Pt(0)
fld = OxmlElement('w:fldSimple')
fld.set(qn('w:instr'), 'TOC \\o "1-2" \\h \\z \\u')
run_el = OxmlElement('w:r')
t_el = OxmlElement('w:t')
t_el.text = '（在 Word 中右键此处选择“更新域”生成目录）'
run_el.append(t_el)
fld.append(run_el)
tocp._p.append(fld)

doc.add_page_break()

# ---------- 一 ----------
h1('一、审阅说明')
h2('（一）平台做什么，不做什么')
body('本平台面向居家场景，由经过培训的陪练人员上门，为脑卒中、骨科术后、心肺疾病和神经疾病患者提供陪伴式训练与过程记录。平台不提供诊断，不解读检查结果，不调整医嘱，不做疗效判断，也不介入用药。训练内容来源于经治医生和康复治疗师给出的方案，平台只负责把“每天该做什么、做到什么程度、出现什么情况必须停”变成可执行、可记录的步骤。')
body('换句话说，这套流程解决的是执行与记录，不解决医学判断。这也是本次审阅的前提。')

h2('（二）为什么需要临床审阅')
body('现存的八套流程由产品侧依据通用康复常规整理，未逐条对齐临床指南，也未经康复专业人员审核。风险集中在三处：一是动作选择与患者所处分期不匹配；二是血压、血氧、心率、疼痛等阈值缺少可追溯依据；三是异常识别与处置边界写得过于绝对或过于笼统。')
body('因此请审阅者判断的核心不是文字表达，而是照着这份流程做，会不会让患者处在不必要的风险中。')

h2('（三）请重点审四件事')
body('第一，动作安全性。每一步列出的动作，对该病种、该阶段的患者是否安全，是否存在漏写的禁忌，是否存在应当禁止却写成了“可以做”的内容。', space_after=3)
body('第二，阈值合理性。表格中出现的血压、血氧、心率、疼痛分值、时长、角度限制，是否应调整或补充。', space_after=3)
body('第三，异常识别与转介。附录B 的九类现场异常，判断标准与现场处置动作是否正确，是否存在应当补充的情境。', space_after=3)
body('第四，边界措辞。平台自称“不诊断、不治疗”，第九部分的对外声明是否越界，是否需要补充限制。', space_after=3)

h2('（四）审阅与反馈方式')
body('建议先读第二部分（总览）和第八部分（阈值清单），再按第三至第七部分逐套流程过一遍。每一步给出三档判断：可接受、需修改、建议删除。需要修改的，请在第十部分写明“加一句什么”或“改成什么”，只写“不妥”会难以落地。')
body('若时间有限，优先审第八部分阈值清单与附录B 异常指引，这两处一旦有误，其他内容写得再细也无法补救。')

# ---------- 二 ----------
h1('二、流程体系总览')
body('平台把一次上门陪练拆成固定六段骨架：到场安全检查、病种专项判断（今天能不能练）、热身、核心训练、放松收尾、填量表与家属交底。八套流程共用第一段与最后两段，差异集中在“专项判断”和“核心训练”。')
body('这样切分的目的，是让陪练人员在每一步只有一个明确的问题要回答，避免一次性丢给非专业人员一长串动作清单。')

caption('表 1　八套流程一览')
rows = []
meta_rows = [
    ('Brunnstrom Ⅰ–Ⅱ 期', '脑卒中、脑出血、脑外伤术后、脑肿瘤术后，处于卧床或床边期', 'o0', '卧床期良肢位摆放与被动活动的角度限度'),
    ('Brunnstrom Ⅲ 期', '同上，已能辅助下坐站', 'o1', '坐站转移的辅助程度与共同运动抑制强度'),
    ('Brunnstrom Ⅳ–Ⅴ 期', '同上，出现分离运动', 'o2', '上下台阶与步行训练的进阶条件'),
    ('Brunnstrom Ⅵ 期', '同上，接近独立', 'o3', '精细手功能与社区模拟的强度上限'),
    ('骨科术后', '关节置换、骨折术后、腰颈疾病、肩袖损伤等 24 个病种', 'o', '负重限制、关节角度红线与血栓风险提示'),
    ('心肺', '冠心病与支架术后、心衰、慢阻肺、肺纤维化等 10 个病种', 'c', '运动心率上限与血氧停止线'),
    ('神经（非偏瘫）', '帕金森、脊髓损伤、多发性硬化、周围神经损伤等 20 个病种', 'n', '体位性低血压、压疮与转移安全'),
    ('通用', '内科与代谢、老年衰弱及其他共 12 个病种', 'g', '是否有必要保留，或并入以上流程'),
]
for label, scope, key, focus in meta_rows:
    kmap = {'o0': '0', 'o1': '1', 'o2': '2', 'o3': '3'}
    steps = FLOWS[kmap.get(key, key)]
    total = sum(s['minutes'] for s in steps)
    rows.append([label, scope, str(len(steps)), '约 %d 分钟' % total, focus])
add_table(['流程', '适用病种（举例）', '步数', '净训练时长', '最需要审阅者确认的点'], rows,
          [3.4, 5.6, 1.2, 2.3, 3.5])
body('说明：净训练时长指流程内各步骤分钟数之和，不含往返、更衣与家属沟通时间。', indent=False, space_after=6)

# ---------- 三 ----------
h1('三、偏瘫流程（Brunnstrom 四期）')
h2('（一）四期共用的四步')
body('四期共用到场安全检查、热身与关节活动、放松与收尾、填写量表与家属交底，差异只在核心训练。下面以 Ⅰ–Ⅱ 期完整列出九步，其余三期只列核心动作对照。')
caption('表 2　Brunnstrom Ⅰ–Ⅱ 期九步')
rows = []
for i, s in enumerate(FLOWS['0']):
    rows.append([
        ['%d. %s' % (i + 1, s['title']), s['phaseLabel']],
        '%d' % s['minutes'],
        s['cues'],
        s['donts'],
        s['stops'],
    ])
add_table(['步骤', '时长（分）', '怎么做', '不能做', '出现这些就停'], rows, [3.0, 1.0, 4.6, 3.7, 3.7])

h2('（二）四期核心动作对照')
body('下表只列核心训练部分，便于横向比较进阶条件是否成立。每一步的详细提示语与停止条件在平台内可展开查看，此处不重复。')
caption('表 3　四期核心动作对照')
maxn = max(len([s for s in FLOWS[k] if s['phase'] == 2]) for k in ('0', '1', '2', '3'))
rows = []
for idx in range(maxn):
    row = [str(idx + 1)]
    for k in ('0', '1', '2', '3'):
        core = [s['title'] for s in FLOWS[k] if s['phase'] == 2]
        row.append(core[idx] if idx < len(core) else '—')
    rows.append(row)
add_table(['序号', 'Ⅰ–Ⅱ 期', 'Ⅲ 期', 'Ⅳ–Ⅴ 期', 'Ⅵ 期'], rows, [1.4, 3.7, 3.7, 3.6, 3.6])

# ---------- 四 ----------
h1('四、骨科术后流程')
body('适用关节置换、各类骨折术后、腰颈疾病、肩袖损伤等。核心逻辑是保护性负重、控制肿胀、恢复活动度、逐步承重，三个红线分别是医嘱负重、关节角度限制与血栓风险。')
caption('表 4　骨科术后流程八步')
rows = []
for i, s in enumerate(FLOWS['o']):
    rows.append([['%d. %s' % (i + 1, s['title']), s['phaseLabel']], '%d' % s['minutes'], s['cues'], s['donts'], s['stops']])
add_table(['步骤', '时长（分）', '怎么做', '不能做', '出现这些就停'], rows, [3.0, 1.0, 4.6, 3.7, 3.7])

# ---------- 五 ----------
h1('五、心肺流程')
body('适用冠心病与支架术后、搭桥术后、心衰稳定期、慢阻肺、肺纤维化等。核心逻辑是强度控制：先测三项，再决定练不练、练多久，全程以“能说话不喘”为强度上限。')
caption('表 5　心肺流程八步')
rows = []
for i, s in enumerate(FLOWS['c']):
    rows.append([['%d. %s' % (i + 1, s['title']), s['phaseLabel']], '%d' % s['minutes'], s['cues'], s['donts'], s['stops']])
add_table(['步骤', '时长（分）', '怎么做', '不能做', '出现这些就停'], rows, [3.0, 1.0, 4.6, 3.7, 3.7])

# ---------- 六 ----------
h1('六、神经流程（非偏瘫）')
body('适用帕金森病、脊髓损伤、多发性硬化、周围神经损伤、脑瘫儿童等。核心逻辑是防跌倒、防压疮、保持转移安全，训练目标落在能自己完成的日常任务上。')
caption('表 6　神经流程八步')
rows = []
for i, s in enumerate(FLOWS['n']):
    rows.append([['%d. %s' % (i + 1, s['title']), s['phaseLabel']], '%d' % s['minutes'], s['cues'], s['donts'], s['stops']])
add_table(['步骤', '时长（分）', '怎么做', '不能做', '出现这些就停'], rows, [3.0, 1.0, 4.6, 3.7, 3.7])

# ---------- 七 ----------
h1('七、通用流程')
body('兜底流程，适用内科与代谢、老年衰弱及其他病种。核心是从患者主诉里挑一件最影响生活的事，拆成三小步当天做完。这一套内容最“薄”，是否需要保留，请审阅者给意见。')
caption('表 7　通用流程七步')
rows = []
for i, s in enumerate(FLOWS['g']):
    rows.append([['%d. %s' % (i + 1, s['title']), s['phaseLabel']], '%d' % s['minutes'], s['cues'], s['donts'], s['stops']])
add_table(['步骤', '时长（分）', '怎么做', '不能做', '出现这些就停'], rows, [3.0, 1.0, 4.6, 3.7, 3.7])

# ---------- 八 ----------
h1('八、需要确认的阈值与禁忌')
body('下列数值与限制是流程执行时的硬性触发条件，多数来自通用康复与运动安全常规，未逐条对齐具体指南。请逐条确认是否沿用，需要改的直接在“请确认”一栏写建议值。')
caption('表 8　阈值与禁忌确认清单')
th = [
    ('1', '训练前血压', '≥180/110 mmHg 或 ≤90/60 mmHg 当日不训练', '全流程', '取自高血压与运动康复通用阈值', '是否沿用／建议值'),
    ('2', '静息血氧', '＜90% 不训练；训练中＜88% 立即停止', '心肺', '依据低氧血症常见处置口径', '是否沿用／建议值'),
    ('3', '运动心率上限', '未设统一数值，写“按医嘱上限”', '心肺', '患者基础病差异大，避免一律套公式', '是否改为静息心率加 20 至 30 次／分，或按年龄公式'),
    ('4', '运动强度口语标准', '以“能说话不喘”为上限', '心肺', '对应 Borg 11 至 13 的口语化表达', '措辞是否可被非专业人员正确理解'),
    ('5', '疼痛', 'VAS ≥7，或较上次增加 ≥3 分，停止当前动作', '全流程', '经验阈值，非指南原文', '是否沿用／建议值'),
    ('6', '关节角度限制', '髋屈曲不超过 90°，禁止内旋', '髋关节置换、股骨近端骨折术后', '防脱位的常规限制', '是否按手术入路区分'),
    ('7', '冰敷', '15 分钟、隔布、术后 48 小时后', '骨科', '常规消肿处理', '是否正确、是否需限定部位'),
    ('8', '体位变换', '每 30 分钟一次', '脊髓损伤、长期卧床', '压疮预防常规', '是否随风险分级调整'),
    ('9', '抽搐', '持续超过 5 分钟或反复发作按急症处理', '神经', '癫痫持续状态通用口径', '是否沿用'),
    ('10', '跌倒后', '头部着地即使当时清醒也建议就医观察', '全流程', '警惕迟发颅内出血', '是否沿用'),
    ('11', '训练与进餐间隔', '饭后 1 小时内不训练', '心肺', '避免餐后血液重新分布', '是否沿用'),
    ('12', '憋气禁忌', '抗阻训练中不憋气，禁止瓦尔萨尔瓦动作', '心肺、骨科', '防血压剧烈波动', '是否沿用'),
    ('13', '单次总时长', '40 至 55 分钟，含组间休息', '全流程', '居家陪练通常不超过 1 小时', '是否应分病种设上限'),
    ('14', '家属交底', '每次结束向家属说明今天做了什么、晚上注意什么', '全流程', '记录与连续性的需要', '交底内容是否需固定清单'),
]
add_table(['序号', '项目', '当前设置', '适用范围', '依据说明', '请确认'], [list(r) for r in th],
          [1.0, 2.3, 4.4, 2.2, 3.6, 2.5])
body('其中第 3 项是刻意没有写死的。心肺患者的运动心率上限若统一套公式，对服用 β 受体阻滞剂的患者会偏高，对心衰患者可能偏高或偏低，因此当前写法是“按医嘱”，把判断权留给经治医生。若临床上有更稳妥的默认写法，请直接给出。', space_after=6)

# ---------- 九 ----------
h1('九、平台边界声明（拟对外文案，请一并审）')
body('以下文字拟用于平台首页与陪练人员告知环节，请判断是否越界、是否存在应当补充的限制。')
for line in (
    '平台不提供诊断，不解读检查报告与影像结果，不据此给出治疗建议。',
    '平台不调整医嘱。医生给出的负重、角度、用药与运动限制，平台只执行与记录，不更改。',
    '平台不做疗效承诺，不承诺功能恢复程度与时间。',
    '平台不推荐、不代购、不解读任何药物。',
    '发现异常时，平台只做识别、记录与转介，现场处置限于停止训练、体位安置与呼叫急救。',
    '量表仅用于过程记录与趋势观察，不作为诊断依据，也不作为疗效评价结论。',
    '陪练人员不实施侵入性操作，不做手法治疗，不进行关节松动、按摩与牵伸以外的任何治疗性手法。',
):
    body(line, space_after=3)

# ---------- 十 ----------
h1('十、审阅反馈表')
body('请对需要修改的步骤填写意见，其余留空即可。若整段流程存在系统性问题（例如分期划分不成立），写在“总体意见”里更有效。')
caption('表 9　逐条意见')
rows = [[str(i + 1), '', '', ''] for i in range(12)]
add_table(['序号', '流程与步骤（填写）', '判断（可接受／需修改／建议删除）', '具体修改意见'], rows, [1.2, 5.6, 4.2, 5.0])

caption('表 10　总体意见')
rows = [['整体可用性', '', ], ['最大风险点', ''], ['建议优先修改的三处', '']]
add_table(['项目', '意见'], [list(r[:2]) for r in rows], [4.0, 12.0])

body('审阅人签名：　　　　　　　　　单位：　　　　　　　　　　日期：　　　年　　月　　日', indent=False, space_after=6)

# ---------- 附录A ----------
doc.add_page_break()
h1('附录A　病种与默认流程对照')
body('平台按病种自动选择流程，患者也可由陪练人员手动调整。下表为当前映射，请重点看是否有病种被分到了不合适的流程。')
label_map = {'0': 'Brunnstrom Ⅰ–Ⅱ 期', '1': 'Brunnstrom Ⅲ 期', '2': 'Brunnstrom Ⅳ–Ⅴ 期', '3': 'Brunnstrom Ⅵ 期',
             'o': '骨科术后', 'c': '心肺', 'n': '神经（非偏瘫）', 'g': '通用'}
rows = []
group_idx = []
for g in CAT['G']:
    group_idx.append(len(rows))
    rows.append(['【%s】' % g['group'], '', ''])
    for it in g['items']:
        pid = CAT['P'].get(it, 'g')
        rows.append([it, label_map.get(pid, pid)])
add_table(['病种', '默认流程'], rows, [10.0, 6.0], group_rows=set(group_idx))

# ---------- 附录B ----------
doc.add_page_break()
h1('附录B　现场异常指引卡')
body('陪练人员在现场遇到下列情况时，平台会弹出对应卡片。请判断每类情境的判断标准、现场动作与分级是否正确，是否有应当补充的情境（例如低血糖、过敏、导管脱落）。')
caption('表 B.1　九类现场异常')
rows = []
for x in INC:
    rows.append([x['title'], x['label'], x['dos'], x['donts']])
add_table(['情境', '分级', '现场该做', '不能做'], rows, [4.0, 2.2, 5.4, 4.4])
body('另有六类情境建议一并评估是否纳入：低血糖、体位性低血压晕厥、导管与引流管脱落、误吸与呛咳、皮肤破损、家属情绪冲突。', space_after=6)

# ---------- 附录C ----------
doc.add_page_break()
h1('附录C　版本记录')
caption('表 C.1　版本与审阅状态')
add_table(['版本', '日期', '主要变更', '审阅状态'],
          [['v0.8', '2026-11-18', '病种目录扩充至 70 项，新增诊断报告上传', '未审'],
           ['v0.9', '2026-11-19', '通用流程拆分为骨科术后、心肺、神经三套；新增阈值清单与审阅反馈表', '待审']],
          [2.2, 3.0, 7.4, 3.4])

# ---------- 页码 ----------
footer = sec.footer
fp = footer.paragraphs[0]
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
fp.paragraph_format.first_line_indent = Pt(0)
fld2 = OxmlElement('w:fldSimple')
fld2.set(qn('w:instr'), 'PAGE')
r2 = OxmlElement('w:r')
t2 = OxmlElement('w:t')
t2.text = '1'
r2.append(t2)
fld2.append(r2)
fp._p.append(fld2)

doc.save(OUT)
print('已生成', OUT)
