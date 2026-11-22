import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveBranchTargets,JUST_CURRENT_BRANCH_TARGET} from '../src/branch-targets.js';
test('single current selector retains actual identity and marks storage separately',()=>{
  const policy={targetsVersion:2,targets:[JUST_CURRENT_BRANCH_TARGET],currentBranch:'main',remotes:[]};
  const target=resolveBranchTargets(policy)[0];
  assert.equal(target.branchKey,'refs/heads/main');
  assert.equal(target.storageMode,'just-current');
  assert.equal(resolveBranchTargets({...policy,currentBranch:'feature/new'})[0].branchKey,'refs/heads/feature/new');
  assert.throws(()=>resolveBranchTargets({...policy,targets:[JUST_CURRENT_BRANCH_TARGET,'main']}),/only target/);
  assert.equal(resolveBranchTargets({...policy,targets:['__CURERNT__']})[0].storageMode,undefined);
  assert.deepEqual(resolveBranchTargets({...policy,targets:[]}),[]);
});
