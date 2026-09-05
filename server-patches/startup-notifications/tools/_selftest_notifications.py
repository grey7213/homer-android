"""Notification CRUD/permission regression using the real route and a temporary DB."""
import tempfile
from pathlib import Path
from types import SimpleNamespace
import ai_fengyue_local_server as server
from notifications_extension import list_notifications


def run():
    with tempfile.TemporaryDirectory(prefix='homer-notices-') as directory:
        store = server.Store(Path(directory) / 'test.sqlite3')
        def request(method, path, body=None, admin=True):
            user = {'id':'test-admin', 'email':'admin@example.test', 'name':'test', 'is_admin':int(admin)}
            handler = SimpleNamespace(store=store, command=method, headers={},
                authenticated_user=lambda:user, authenticated_token_user=lambda:user)
            return server.Handler.route(handler, path, '', body)
        try:
            assert request('POST', '/admin/api/notifications', {}, admin=False)['status'] == 403
            assert request('GET', '/console/api/public/notifications')['data']['list'] == []
            payload={'title':'测试通知', 'content':'第一行\n<script>纯文本</script>', 'enabled':True}
            created=request('POST', '/admin/api/notifications', payload)
            notice_id=created['data']['id']
            assert len(request('GET','/admin/api/notifications')['data']['list']) == 1
            assert request('GET','/console/api/public/notifications')['data']['list'][0]['content'] == payload['content']
            assert request('PUT','/admin/api/notifications/'+notice_id,{**payload,'title':'编辑后','enabled':False})['data']['id'] == notice_id
            assert list_notifications(store, public=True) == []
            assert list_notifications(store)[0]['title'] == '编辑后'
            assert request('PUT','/admin/api/notifications/'+notice_id,{**payload,'enabled':'false'})['status'] == 400
            assert request('POST','/admin/api/notifications',{**payload,'title':' '})['status'] == 400
            assert request('DELETE','/admin/api/notifications/'+notice_id, admin=False)['status'] == 403
            assert request('DELETE','/admin/api/notifications/'+notice_id)['data']['deleted']
            assert request('PUT','/admin/api/notifications/'+notice_id,payload)['status'] == 404
            assert list_notifications(store) == []
            assert request('POST','/console/api/public/notifications',payload)['status'] == 405
            assert request('PUT','/admin/api/notifications',payload)['status'] == 400
            print('PASS notifications: create/read/edit/disable/delete, admin boundary, validation, missing record, public read-only')
        finally:
            store.conn.close()

if __name__ == '__main__': run()
