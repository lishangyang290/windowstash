import { describe, expect, it } from 'vitest';
import { evidenceForOperation, groupDiagnosticFindings } from './diagnosticPresentation';
import { makeBundle, type DiagnosticEvent, type Finding } from './diagnostics';
const deviceId = 'a'.repeat(64);
const id = (last: string) => `00000000-0000-4000-8000-${last.padStart(12,'0')}`;
function event(n: number, operation: number, eventName='sync.failed'): DiagnosticEvent {
  return { id: id(String(n)), operationId: id(String(operation+100)), timestamp: `2026-10-15T10:00:${String(n).padStart(2,'0')}Z`, component:'companion', level:'ERROR',
    event:eventName, result:'failed', deviceId, processId:id('7777'), devicePlatform:'windows', buildId:'development', source:'shared/realtimeSync.ts:RealtimeSync',state:{} };
}
function finding(anchor: DiagnosticEvent, symptom: string): Finding {
  return { confidence: 'suspected', symptom, evidence:[anchor.id], firstAbnormal:anchor.id, devices:[anchor.deviceId],
    components:[anchor.component], source:[anchor.source], hypothesis:'需要核实', check:'优先检查队列', missing:[] };
}
describe('diagnostics presentation', () => {
  it('coalesces multiple findings of the same exact operation without losing evidence', () => {
    const a=event(1,1), b=event(2,1), other=event(3,2);
    const bundle={ ...makeBundle([a,b,other], {}, Date.parse('2026-10-15T10:01:00Z')),
      findings:[finding(a,'异常甲'),finding(b,'异常乙'),finding(other,'另一操作')] };
    const grouped=groupDiagnosticFindings(bundle);
    expect(grouped).toHaveLength(2);
    expect(grouped[1]?.findings).toHaveLength(2);
    expect(grouped[1]?.eventIds).toEqual([a.id,b.id]);
    expect(grouped[0]?.findings).toHaveLength(1);
  });
  it('links only explicit graph edges or exact operation scope, never adjacent times', () => {
    const a=event(1,1), b=event(2,2), related=event(3,3);
    const bundle={ ...makeBundle([a,b,related],{},Date.parse('2026-10-15T10:01:00Z')),
      links:[{from:a.id,to:related.id,basis:'parent-event' as const}] };
    const result=evidenceForOperation(bundle,a);
    expect(result.map(e=>e.id)).toEqual([a.id,related.id]);
    expect(result.map(e=>e.id)).not.toContain(b.id);
  });
  it('keeps versioned and unversioned stages of one operation together and matches exact cross-device versions', () => {
    const a=event(1,1), b={ ...event(2,1), workspaceRef:'b'.repeat(64),cloudVersion:'2026-10-15T10:00:00.123456Z' };
    const remote={ ...event(3,2), deviceId:'c'.repeat(64),workspaceRef:b.workspaceRef,cloudVersion:b.cloudVersion };
    const differentVersion={ ...event(4,3), workspaceRef:b.workspaceRef,cloudVersion:'2026-10-15T10:00:00.123457Z' };
    const unrelated={ ...event(5,1), deviceId:'d'.repeat(64) };
    const bundle={ ...makeBundle([a,b,remote,differentVersion,unrelated]), findings:[a,b,remote,differentVersion,unrelated].map(e=>finding(e,'等待核对')) };
    const groups=groupDiagnosticFindings(bundle);
    expect(groups).toHaveLength(3);
    expect(groups.find(g=>g.findings.length===3)?.eventIds).toEqual([a.id,b.id,remote.id]);
    expect(bundle.findings).toHaveLength(5);
  });
  it('keeps the representative anchor aligned with the strongest evidence', () => {
    const failed=event(1,1), later=event(2,1);
    const confirmed={...finding(failed,'已失败'),confidence:'confirmed' as const};
    const bundle={...makeBundle([failed,later]),findings:[confirmed,finding(later,'待确认')]};
    const group=groupDiagnosticFindings(bundle)[0]!;
    expect(group.representative).toBe(confirmed);
    expect(group.anchor?.id).toBe(failed.id);
    expect(group.timestamp).toBe(later.timestamp.replace('Z','.000Z'));
  });
  it('groups a controller failure and its explicitly linked cloud request without merging adjacent operations', () => {
    const controller=event(1,1), cloud={...event(2,2,'cloud.failed'),parentEventId:controller.id};
    const unrelated=event(3,3);
    const bundle={...makeBundle([controller,cloud,unrelated]),findings:[controller,cloud,unrelated].map(e=>finding(e,'失败'))};
    const groups=groupDiagnosticFindings(bundle);
    expect(groups).toHaveLength(2);
    expect(groups.find(g=>g.findings.length===2)?.eventIds).toEqual([controller.id,cloud.id]);
  });
});
