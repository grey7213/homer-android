"""Promotion moderation for authenticated publishing surfaces; no outbound URL fetches.

Call only after ownership/resource validation, never on draft preflight. The caller
owns the transaction: persist a rejected attempt outside the content savepoint.
"""
import json
import re
import time
import unicodedata
from urllib.parse import urlsplit


class PromotionRejected(Exception):
    def __init__(self, text, surface, verdict):
        super().__init__('检测到推广引流，内容未发布。请在账号状态查看禁言原因或申诉。')
        self.text, self.surface, self.verdict = text, surface, verdict
        self.status, self.kind = 403, 'promotion_muted'


def classify(text):
    normalized = unicodedata.normalize('NFKC', str(text)).casefold()
    normalized = ''.join(c for c in normalized if unicodedata.category(c) != 'Cf')
    compact = re.sub(r'\s+', '', normalized)
    urls = re.findall(r'https?://[^\s<>\]）)]+', normalized)
    hosts = set()
    for url in urls:
        try: hosts.add(urlsplit(url).hostname or '')
        except ValueError: pass
    # Reporting/quoting a pitch is reviewed, not treated as the reporter's promotion.
    quoting = bool(re.search(r'举报|广告示例|引流示例|不要点击|别点|骗子|诈骗|防骗|疑似广告', compact))
    private = bool(re.search(r'私我|私信我|私聊我|找我领取|加我领取', compact))
    offer = bool(re.search(r'无偿|免费|白嫖', compact))
    unrestricted = bool(re.search(r'无限制|解除ai限制|ai破甲|ai解限', compact))
    download = bool(re.search(r'软件下载|软件获取|备用方法|备用地址|点击下载|立即下载|软件网址', compact))
    ai = bool(re.search(r'ai软件|ai破甲|解除ai限制|ai聊天|ai解限', compact))
    known_destination = any(h == 'pveso.com' or h.endswith('.pveso.com') for h in hosts)
    reasons = []
    if private and offer and unrestricted:
        reasons.append('免费/无偿、解除限制与私聊领取组合推广')
    if urls and download and (ai or unrestricted):
        reasons.append('AI 软件获取/下载引流话术与外部地址组合')
    elif urls and download and re.search(r'软件|app|应用', compact) and (offer or re.search(r'立即下载|备用方法|备用地址',compact)):
        reasons.append('应用获取/备用下载地址与推广邀请组合')
    if known_destination and re.search(r'这是地址|下载|领取|来玩|快来|注册', compact):
        reasons.append('已确认推广目标与引导访问话术组合')
    return {'action': 'review' if quoting and reasons else 'mute' if reasons else 'allow', 'reasons': reasons}


def active_mute(conn, uid, now=None):
    now = int(time.time()*1000) if now is None else now
    return conn.execute("SELECT id FROM social_sanctions WHERE user_id=? AND kind IN ('mute','ban') AND revoked=0 AND (until_at=0 OR until_at>?) LIMIT 1", (str(uid), now)).fetchone()


def enforce(conn, uid, text, surface):
    if active_mute(conn, uid):
        raise ValueError('当前账号处于禁言状态，可在“我的 → 设置 → 账号状态与申诉”查看原因')
    verdict = classify(text)
    if verdict['action'] == 'mute':
        raise PromotionRejected(text, surface, verdict)
    return verdict


def record_rejection(conn, uid, exc, now=None):
    """Persist once per active sanction. Requires the host lock and explicit commit."""
    uid = str(uid)
    now = int(time.time()*1000) if now is None else now
    existing = active_mute(conn, uid, now)
    if existing:
        return existing[0]
    # Card comments may be the account's first interaction with the community.
    # Keep it visible in the existing moderator user list without granting consent.
    conn.execute('INSERT OR IGNORE INTO social_members(user_id,name) VALUES(?,?)', (uid, '用户 '+uid[:8]))
    row = conn.execute("SELECT value FROM social_config WHERE key='promotion_mute_days'").fetchone()
    try:
        days = max(1, min(365, int(row[0]) if row else 1))
    except (ValueError, TypeError):
        days = 1
    reason = '自动检测推广引流：' + '；'.join(exc.verdict['reasons']) + f'。禁言 {days} 天；如属误判可申诉。'
    cur = conn.execute('INSERT INTO social_sanctions(user_id,kind,until_at,category,reason,actor,created_at,revoked) VALUES(?,?,?,?,?,?,?,0)',
                       (uid, 'mute', now+days*86400000, 'diversion', reason, 'system:promotion', now))
    sid = cur.lastrowid
    # Evidence stays in the existing moderator-only audit log, never public notices.
    evidence = {'surface': exc.surface, 'content': exc.text[:10100], 'rule_reasons': exc.verdict['reasons'], 'sanction_id': sid}
    conn.execute('INSERT INTO social_audit(actor,action,object_type,object_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
                 ('system:promotion', 'auto_mute', 'user', uid, reason, json.dumps(evidence, ensure_ascii=False), '{}', now))
    conn.execute('INSERT OR IGNORE INTO social_notices(user_id,kind,title,post_id,actor,created_at,event_key) VALUES(?,?,?,?,?,?,?)',
                 (uid, 'system', reason, '', '', now, 'promotion:'+str(sid)))
    return sid
