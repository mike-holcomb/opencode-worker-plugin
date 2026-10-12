import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowsDeclaredEdit } from './permissions.mjs';
const workspace='/private/tmp/fixture/workspace',target=`${workspace}/retry.py`;
const check=(patterns,filepath=target,permission='edit')=>allowsDeclaredEdit({permission,patterns,metadata:{filepath}},workspace,[target]);
test('declared edit accepts absolute, relative, and corroborated OpenCode stripped paths',()=>{
  assert(check([target]));assert(check(['retry.py']));assert(check([target.slice(1)]));
});
test('edit scope rejects undeclared targets, traversal, wildcards, and uncorroborated stripped paths',()=>{
  assert(!check([target.slice(1)],'/other/retry.py'));
  assert(!check([`${workspace}/other.py`]));assert(!check(['../retry.py']));
  assert(!check(['*']));assert(!check(['retry.py','other.py']));assert(!check([]));
  assert(!check(['retry.py'],target,'bash'));assert(!check([null]));
});
