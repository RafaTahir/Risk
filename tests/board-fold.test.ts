import { describe, expect, it } from 'vitest';
import { boardFoldPose, boardPanel, clipPanelRing, clipPanelSegment, PANEL_BOUNDS } from '../src/lib/boardFold';
import { TERRITORIES } from '../shared/world';
import { boardContour } from '../src/lib/boardContours';
const area = (ring: readonly {x:number;y:number}[]) => Math.abs(ring.reduce((s,p,i)=>{const q=ring[(i+1)%ring.length];return s+p.x*q.y-q.x*p.y;},0)/2);
describe('four physical board panels',()=>{
  it('folds the free corner then the right stack and finally the lower stack, with reversible endpoints',()=>{
    expect(boardFoldPose(0)).toEqual({upper:0,horizontal:0,vertical:0,x:0,y:0});
    expect(boardFoldPose(1/3)).toEqual({upper:Math.PI,horizontal:0,vertical:0,x:0,y:0});
    const middle=boardFoldPose(2/3);expect(middle.upper).toBe(Math.PI);expect(middle.vertical).toBe(-Math.PI);expect(middle.horizontal).toBe(0);
    expect(boardFoldPose(1)).toEqual({upper:Math.PI,horizontal:-Math.PI,vertical:-Math.PI,x:284,y:-165});
    for(let i=0;i<=100;i++){const p=i/100,forward=boardFoldPose(p),reverse=boardFoldPose(1-(1-p));expect(forward.upper).toBeCloseTo(reverse.upper,12);expect(forward.horizontal).toBeCloseTo(reverse.horizontal,12);expect(forward.vertical).toBeCloseTo(reverse.vertical,12);}
    expect(boardFoldPose(-1)).toEqual(boardFoldPose(0));expect(boardFoldPose(2)).toEqual(boardFoldPose(1));
  });
  it('preserves printed territory area when cutting at both physical creases',()=>{
    for(const territory of TERRITORIES)for(const ring of boardContour(territory.id).rings){
      const parts=PANEL_BOUNDS.map((bounds,i)=>{const clipped=clipPanelRing(ring,i);for(const p of clipped){expect(p.x).toBeGreaterThanOrEqual(bounds.minX);expect(p.x).toBeLessThanOrEqual(bounds.maxX);expect(p.y).toBeGreaterThanOrEqual(bounds.minY);expect(p.y).toBeLessThanOrEqual(bounds.maxY);}return area(clipped);});
      expect(parts.reduce((sum,n)=>sum+n,0)).toBeCloseTo(area(ring),5);
    }
  });
  it('clips only original ink segments and keeps exact adjoining crease intersections',()=>{
    const a={x:450,y:220},b={x:650,y:420};
    expect(clipPanelSegment(a,b,0)).toEqual([a,{x:550,y:320}]);
    expect(clipPanelSegment(a,b,3)).toEqual([{x:550,y:320},b]);
    expect(clipPanelSegment(a,b,1)).toBeNull();expect(clipPanelSegment(a,b,2)).toBeNull();
    expect([boardPanel(100,100),boardPanel(900,100),boardPanel(100,500),boardPanel(900,500)]).toEqual([0,1,2,3]);
  });
});
