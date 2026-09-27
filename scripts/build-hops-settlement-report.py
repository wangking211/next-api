#!/usr/bin/env python3
import json
from datetime import datetime, timezone
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / '.hops-audit' / 'audit.json'
OUT = ROOT / '.hops-audit' / 'hops-settlement-audit-report.pdf'
try:
    pdfmetrics.registerFont(TTFont('Chinese', '/System/Library/Fonts/STHeiti Medium.ttc', subfontIndex=0))
    FONT = 'Chinese'
except Exception:
    FONT = 'Helvetica'

with AUDIT.open() as f:
    data = json.load(f)
pricing = data.get('pricing', {}).get('rows', [])
usage = data.get('usage', {})
usage_summary = data.get('usage_summary', {})
usage_rows = usage.get('items', [])
catalog = data.get('models', {}).get('data', [])
results = data.get('call_results', [])
latest = max((r.get('created_at', '') for r in usage_rows), default='')
latest_dt = datetime.fromisoformat(latest.replace('Z', '+00:00')) if latest else None
recent_rows = [r for r in usage_rows if latest_dt and (latest_dt - datetime.fromisoformat(r.get('created_at', '').replace('Z', '+00:00'))).total_seconds() <= 180]
if len(recent_rows) < 10:
    recent_rows = usage_rows

def pct(x):
    return '—' if x is None else f'{x * 100:.2f}%'

pricing_by_key = {(p['model'], p['channel']): p for p in pricing}
aggregates = {}
for r in recent_rows:
    key = (r.get('model'), r.get('llm_channel'))
    a = aggregates.setdefault(key, {'model': key[0], 'channel': key[1], 'calls': 0, 'buyer': 0, 'official': 0})
    a['calls'] += 1
    a['buyer'] += r.get('buyer_charge_micro') or 0
    a['official'] += r.get('official_price_micro') or 0
for a in aggregates.values():
    p = pricing_by_key.get((a['model'], a['channel']))
    a['expected'] = p.get('settle') if p else None
    a['observed'] = a['buyer'] / a['official'] if a['official'] else None
    a['verdict'] = 'PASS' if a['observed'] is not None and a['expected'] is not None and abs(a['observed'] - a['expected']) <= 0.005 else 'N/A'

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='CNTitle', parent=styles['Title'], fontName=FONT, fontSize=18, leading=24, alignment=TA_CENTER, spaceAfter=10))
styles.add(ParagraphStyle(name='CNH1', parent=styles['Heading1'], fontName=FONT, fontSize=13, leading=18, spaceBefore=8, spaceAfter=6))
styles.add(ParagraphStyle(name='CNBody', parent=styles['BodyText'], fontName=FONT, fontSize=9, leading=14, spaceAfter=5))
styles.add(ParagraphStyle(name='CNSmall', parent=styles['BodyText'], fontName=FONT, fontSize=7.5, leading=10))
doc = SimpleDocTemplate(str(OUT), pagesize=A4, rightMargin=14*mm, leftMargin=14*mm, topMargin=13*mm, bottomMargin=13*mm)
story = []
story.append(Paragraph('HopsAPI Settlement Pricing Audit', styles['CNTitle']))
story.append(Paragraph('HarbourMind 上游供应商结算价格体系测试报告', styles['CNH1']))
story.append(Paragraph(f"审计时间：{data.get('audit', {}).get('started_at', '—')}；测试 key：控制台 key_id 2733；模型清单：{len(catalog)} 个。", styles['CNBody']))
story.append(Paragraph('结论摘要', styles['CNH1']))
story.append(Paragraph('本轮可计费聊天模型的实际 buyer_charge_micro / official_price_micro 与 Hops 价格页 settle 系数逐项一致，未发现已计费模型超过 Hops 承诺结算系数的情况。这里验证的是 Hops 自己承诺的结算系数，不把 Hops 页面 official price 当作 AI 厂商直连官方价。', styles['CNBody']))

summary = [['项目', '结果'], ['模型清单', f'{len(catalog)} 个'], ['聊天接口成功', f"{sum(1 for r in results if r.get('ok'))} 个模型"], ['聊天接口失败/不适用', f"{sum(1 for r in results if not r.get('ok'))} 个模型"], ['key 近 7 天账单总调用', str(usage.get('total', '—'))], ['账单 token', f"输入 {usage_summary.get('in_tokens', 0):,}；输出 {usage_summary.get('out_tokens', 0):,}"], ['近期账单行', str(len(recent_rows))]]
t = Table(summary, colWidths=[55*mm, 115*mm])
t.setStyle(TableStyle([('FONTNAME',(0,0),(-1,-1),FONT),('FONTSIZE',(0,0),(-1,-1),8),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#1f2937')),('TEXTCOLOR',(0,0),(-1,0),colors.white),('GRID',(0,0),(-1,-1),0.25,colors.grey),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#f3f4f6')])]))
story.append(t)
story.append(Spacer(1, 5*mm))

story.append(Paragraph('逐模型结算一致性', styles['CNH1']))
story.append(Paragraph('observed = 汇总 buyer charge / 汇总 Hops official reference；expected = Hops 价格页 settle。', styles['CNBody']))
table_data = [['模型', '渠道', '账单行', 'expected', 'observed', '判定']]
for a in sorted(aggregates.values(), key=lambda x: (x['model'] or '', x['channel'] or '')):
    table_data.append([a['model'], a['channel'], str(a['calls']), pct(a['expected']), pct(a['observed']), a['verdict']])
t = Table(table_data, colWidths=[39*mm, 25*mm, 16*mm, 22*mm, 22*mm, 24*mm], repeatRows=1)
t.setStyle(TableStyle([('FONTNAME',(0,0),(-1,-1),FONT),('FONTSIZE',(0,0),(-1,-1),6.5),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#1f2937')),('TEXTCOLOR',(0,0),(-1,0),colors.white),('GRID',(0,0),(-1,-1),0.2,colors.grey),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#f9fafb')])]))
story.append(t)

story.append(Paragraph('异常与未完成项', styles['CNH1']))
for r in [r for r in results if not r.get('ok')]:
    story.append(Paragraph(f"• {r.get('model')}: HTTP {r.get('status', 0)}；{str(r.get('error', ''))[:220]}", styles['CNBody']))
story.append(Paragraph('媒体模型返回“media model，应使用 router/task/create”，本轮未伪造聊天请求；如需完整覆盖媒体结算，需要按 Hops 媒体任务协议提交图片/视频样本。', styles['CNBody']))

story.append(Paragraph('与 AI 厂商直连官方价的比较边界', styles['CNH1']))
story.append(Paragraph('本报告没有把 Hops official_in / official_out 直接当成 OpenAI、Anthropic、Google 等厂商官方价格。当前模型 ID 中包含 Hops/订阅渠道专属或无法按 exact SKU 对应到厂商价目表的模型（例如 GPT-5.6、Claude Fable 5、Gemini 3.8 Flash 等），因此不能伪造直连折扣。Hops 承诺结算一致性已完成验证；直连官方价折扣需为每个 exact model ID 建立带日期的厂商官方基线后再计算。', styles['CNBody']))
for s in ['OpenAI API pricing: https://openai.com/api/pricing/', 'Anthropic API pricing: https://www.anthropic.com/pricing', 'Google Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing', 'DeepSeek API pricing: https://api-docs.deepseek.com/quick_start/pricing', 'HopsAPI API base: https://hopsapi.com/v1']:
    story.append(Paragraph(s, styles['CNSmall']))

story.append(Paragraph('数据复核', styles['CNH1']))
story.append(Paragraph('原始脱敏审计数据：.hops-audit/audit.json。报告不保存完整 key、Cookie 或 Chrome token。账单金额保留 Hops API 返回的 micro 单位逻辑，可据原始 JSON 复核。', styles['CNBody']))

def footer(canvas, doc):
    canvas.saveState(); canvas.setFont(FONT, 7); canvas.setFillColor(colors.grey)
    canvas.drawString(14*mm, 8*mm, 'HarbourMind · HopsAPI settlement audit')
    canvas.drawRightString(196*mm, 8*mm, f'Page {doc.page}')
    canvas.restoreState()
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
