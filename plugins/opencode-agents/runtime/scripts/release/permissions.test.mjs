import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowsDeclaredEdit, parentPermissionDecision } from './permissions.mjs';
const workspace='/private/tmp/fixture/workspace',target=`${workspace}/retry.py`;
const check=(patterns,filepath=target,permission='edit')=>allowsDeclaredEdit({permission,patterns,metadata:{filepath}},workspace,[target]);
test('declared edit accepts absolute, relative, and corroborated OpenCode stripped paths',()=>{
  assert(check([target]));assert(check(['retry.py']));assert(check([target.slice(1)]));
});
test('parent decisions require exact request and revision and cannot grant persistent authority',()=>{
  const request={requestId:'request-current',revision:7};
  const decision={revision:7,reply:'allow_once',authorization_basis:'Inspected exact fixture command'};
  assert.equal(parentPermissionDecision({'another-request':decision},request),null);
  assert.deepEqual(parentPermissionDecision({'request-current':decision},request),decision);
  for(const invalid of [{...decision,revision:6},{...decision,reply:'allow_always'},{...decision,authorization_basis:''}]){
    assert.throws(()=>parentPermissionDecision({'request-current':invalid},request));
  }
});
test('edit scope rejects undeclared targets, traversal, wildcards, and uncorroborated stripped paths',()=>{
  assert(!check([target.slice(1)],'/other/retry.py'));
  assert(!check([`${workspace}/other.py`]));assert(!check(['../retry.py']));
  assert(!check(['*']));assert(!check(['retry.py','other.py']));assert(!check([]));
  assert(!check(['retry.py'],target,'bash'));assert(!check([null]));
});
