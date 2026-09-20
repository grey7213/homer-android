"""Build a reviewable patch against the backend snapshot; never modify it."""
import ast,difflib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCE=Path('C:/CodexWork/AIXingYue-upstream-20260918/AIXingYue-main/tools/ai_fengyue_local_server.py')
def transform(source):
    tree=ast.parse(source);method=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='spend_credit_points')
    lines=source.splitlines(keepends=True)
    replacement='''    def spend_credit_points(self, user_id, amount, *, event_type="chat_cost", summary="聊天消耗", payload=None):
        return self.spend_with_creator_earnings(user_id, amount, event_type=event_type, summary=summary, payload=payload)
'''
    result=''.join(lines[:method.lineno-1])+replacement+''.join(lines[method.end_lineno:])
    assert result.count('class Store:')==1
    result=result.replace('class Store:', 'from creator_earnings import CreatorEarningsMixin\n\nclass Store(CreatorEarningsMixin):',1)
    result=result.replace('        self.init_schema()','        self.init_schema()\n        self.init_creator_earnings_schema()',1)
    user_route='''        if normalized == "console/api/web/earnings":
            earnings_user = self.authenticated_token_user()
            if not earnings_user:
                return error_response("login required", 401)
            if self.command.upper() != "GET":
                return error_response("method not allowed", 405)
            return ok_response(self.store.creator_earnings(earnings_user["id"]))

'''
    result=result.replace('        if normalized == "console/api/web/rewards":',user_route+'        if normalized == "console/api/web/rewards":',1)
    admin_route='''            if normalized == "admin/api/creator-revenue":
                if self.command.upper() == "GET":
                    return ok_response(self.store.creator_revenue_rate())
                if self.command.upper() == "PUT":
                    try:
                        return ok_response(self.store.update_creator_revenue_rate(user["id"], body.get("rate_bps")))
                    except (ValueError, AttributeError) as exc:
                        return error_response(str(exc), 400)
                return error_response("method not allowed", 405)

'''
    result=result.replace('            if normalized == "admin/api/site-settings":',admin_route+'            if normalized == "admin/api/site-settings":',1)
    # Each upstream response already has a completion ID; share it with billing.
    tree=ast.parse(result);lines=result.splitlines(keepends=True);edits=[]
    for n in ast.walk(tree):
        if not isinstance(n,ast.Call) or not isinstance(n.func,ast.Attribute) or n.func.attr!='spend_credit_points':continue
        kw={k.arg:k.value for k in n.keywords}
        if isinstance(kw.get('event_type'),ast.Constant) and kw['event_type'].value=='sillytavern_chat_cost':
            p=kw['payload'];assert isinstance(p,ast.Dict)
            index=p.lineno;indent=' '*(p.col_offset+4)
            # Match source indentation, not the column of the literal opening brace.
            indent=lines[index][:len(lines[index])-len(lines[index].lstrip())]
            edits.append((index,indent+'"billing_id": completion_id,\n'))
    assert len(edits)==2,edits
    for index,line in sorted(edits,reverse=True):lines.insert(index,line)
    result=''.join(lines);ast.parse(result);return result
if __name__=='__main__':
    before=SOURCE.read_text(encoding='utf-8-sig');after=transform(before)
    module=(ROOT/'server-patches/creator-earnings/creator_earnings.py').read_text(encoding='utf8')
    patch=''.join(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/tools/ai_fengyue_local_server.py',tofile='b/tools/ai_fengyue_local_server.py'))
    patch+=''.join(difflib.unified_diff([],module.splitlines(True),fromfile='/dev/null',tofile='b/tools/creator_earnings.py'))
    (ROOT/'server-patches/creator-earnings/integration.patch').write_text(patch,encoding='utf8')
    print('Generated creator points integration patch; original backend untouched.')
