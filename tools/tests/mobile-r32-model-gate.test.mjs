import test from 'node:test';
import assert from 'node:assert/strict';
import { activateModelScope, confirmModelChange, recordModelFailure, modelIsPaused, requireAvailableModel } from '../../sillytavern-runtime/public/scripts/homer-model-gate.mjs';
const fail = (scope, model, error_code='HM-G502') => recordModelFailure({scope,model,status:'failed',error_code});
test('only a different model unlocks, same model settings and reload do not',()=>{
  activateModelScope('u:c','A');fail('u:c','A');assert(modelIsPaused());
  assert.throws(()=>requireAvailableModel('A'), /更换模型/);
  confirmModelChange('A');activateModelScope('u:c','A');assert(modelIsPaused());
  confirmModelChange('B');assert(!modelIsPaused());confirmModelChange('A');assert(!modelIsPaused());
});
test('late failure cannot lock a different model, account or conversation',()=>{
  activateModelScope('other:c','B');fail('u:old','A');assert(!modelIsPaused());
  activateModelScope('u:old','B');assert(!modelIsPaused());
  activateModelScope('u:old','A');assert(modelIsPaused());
});
test('auth, balance, configuration and cancellation do not pause model',()=>{
  for (const code of ['HM-G400','HM-G401','HM-G402','HM-G403','HM-R422','HM-GLOCK','']) {
    activateModelScope(code,'A');fail(code,'A',code);assert(!modelIsPaused());
  }
  activateModelScope('cancel','A');recordModelFailure({scope:'cancel',model:'A',status:'cancelled',error_code:'HM-G502'});assert(!modelIsPaused());
});
test('all provider failure classes pause',()=>{
  for(const code of ['HM-G204','HM-G429','HM-G502','HM-G503','HM-G504','HM-GNET']){
    activateModelScope(code,'A');fail(code,'A',code);assert(modelIsPaused());
  }
});
