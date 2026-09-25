"""Actual card's alternate frontend, not just iframe existence."""
import argparse,base64,json,re
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
parser=argparse.ArgumentParser();parser.add_argument('--credentials',type=Path,required=True);args=parser.parse_args()
credentials=json.loads(args.credentials.read_text(encoding='utf-8-sig'));user=credentials.get('admin',credentials)
out=Path('output/mobile-r26/card');out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,channel='chrome');page=browser.new_page(viewport={'width':390,'height':844})
 try:
  page.goto('http://127.0.0.1:8082/app/login.html');page.wait_for_load_state('networkidle')
  page.locator('input[type=email]:visible').fill(user['email']);page.locator('input[type=password]:visible').fill(user['password']);page.locator('button[type=submit]:visible').click();page.wait_for_url(lambda u:'login.html' not in u)
  encoded=base64.b64encode(Path('D:/网站/案例1/Image_1790181493425_437.png').read_bytes()).decode()
  card=page.evaluate("async file=>{const {api}=await import('/app/assets/js/app-core.js?v=20260917-r8');return (await api.importCard({card_file:'data:image/png;base64,'+file,filename:'case1.png'})).data}",encoded)
  page.goto('http://127.0.0.1:8082/app/chat.html?app_id='+card['id']);page.wait_for_function("document.body.classList.contains('is-ready')",timeout=90000)
  runtime=next(f for f in page.frames if '/module/dialogue/' in f.url)
  runtime.get_by_role('button',name='下一个开场',exact=True).click()
  frontend=runtime.frame_locator('#chat iframe[id^=TH-message]').frame_locator('iframe')
  try:
   expect(frontend.get_by_text('开始游戏',exact=True)).to_be_visible(timeout=30000)
  except Exception:
   page.screenshot(path=str(out/'failure.png'))
   print(json.dumps({'frames':[{'url':f.url.split('?')[0][:120],'text':f.locator('body').inner_text(timeout=1000)[:700]} for f in page.frames if f!=page.main_frame]},ensure_ascii=False))
   raise
  assert not runtime.locator('.toast-error:visible').count()
  page.screenshot(path=str(out/'start.png'))
  frontend.get_by_text('开始游戏',exact=True).click()
  expect(frontend.get_by_text('开始游戏',exact=True)).not_to_be_visible(timeout=10000)
  page.screenshot(path=str(out/'interactive.png'));print('Actual alternate frontend interaction passed; no extension error toast.')
 finally:browser.close()
