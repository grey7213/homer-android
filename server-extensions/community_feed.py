"""Account-scoped community API adapter for Homer's existing SQLite/auth context."""
import json
import re
import time

TOPICS = ['交流闲聊', '角色故事', '创作交流', '攻略分享', '意见反馈']

def ensure_feed_schema(conn, lock):
    with lock:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS social_posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, author TEXT NOT NULL,
          title TEXT NOT NULL, content TEXT NOT NULL, topic TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
          client_id TEXT NOT NULL, UNIQUE(user_id,client_id));
        CREATE INDEX IF NOT EXISTS social_posts_topic ON social_posts(topic,deleted,id DESC);
        CREATE INDEX IF NOT EXISTS social_posts_author ON social_posts(user_id,deleted,id DESC);
        CREATE TABLE IF NOT EXISTS social_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, user_id TEXT NOT NULL,
          author TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0, client_id TEXT NOT NULL, UNIQUE(user_id,client_id));
        CREATE INDEX IF NOT EXISTS social_comments_post ON social_comments(post_id,deleted,id);
        CREATE TABLE IF NOT EXISTS social_likes (post_id INTEGER NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(post_id,user_id));
        CREATE TABLE IF NOT EXISTS social_saves (post_id INTEGER NOT NULL,user_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(post_id,user_id));
        CREATE INDEX IF NOT EXISTS social_saves_user ON social_saves(user_id,created_at DESC);
        CREATE TABLE IF NOT EXISTS social_follows (user_id TEXT NOT NULL,author_id TEXT NOT NULL,PRIMARY KEY(user_id,author_id));
        CREATE TABLE IF NOT EXISTS social_reports (id INTEGER PRIMARY KEY AUTOINCREMENT,
          post_id INTEGER NOT NULL,user_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,
          UNIQUE(post_id,user_id));
        ''')
        conn.commit()
    from community_service import initialize
    initialize(conn, lock)

def handle_feed_route(method, normalized, query, body, ctx):
    from community_service import handle
    return handle(method, normalized, query, body, ctx)
