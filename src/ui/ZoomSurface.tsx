import React,{useEffect,useLayoutEffect,useRef} from 'react';
import {wheelZoom} from './zoom';

// Only the diagram captures wheel events. Text, lists and the other panes retain
// normal scrolling. Anchor against actual post-render geometry, not a guessed size.
export function ZoomSurface({zoom,change,children,reflow=false}:{zoom:number;change:(zoom:number)=>void;children:React.ReactNode;reflow?:boolean}){
  const ref=useRef<HTMLDivElement>(null),current=useRef({zoom,change});current.current={zoom,change};
  const anchor=useRef<{element:Element;x:number;y:number;u:number;v:number}|null>(null);
  useEffect(()=>{
    const root=ref.current!;
    const wheel=(event:WheelEvent)=>{
      const surface=(event.target as Element).closest('[data-zoom-surface]');
      if(!surface||!event.ctrlKey||!event.deltaY)return;
      event.preventDefault();
      const next=wheelZoom(current.current.zoom,event.deltaY,event.deltaMode);
      if(next===current.current.zoom)return;
      const element=(event.target as Element).closest('[data-zoom-anchor]')||surface,box=element.getBoundingClientRect();
      anchor.current={element,x:event.clientX,y:event.clientY,u:(event.clientX-box.left)/box.width,v:(event.clientY-box.top)/box.height};
      current.current.change(next);
    };
    root.addEventListener('wheel',wheel,{passive:false});return()=>root.removeEventListener('wheel',wheel);
  },[]);
  useLayoutEffect(()=>{
    const a=anchor.current;anchor.current=null;if(!a||!a.element.isConnected)return;
    // An architecture diagram can have an inner horizontal scroller. Consume
    // movement there first, then pass any remaining movement to the canvas.
    for(let el=a.element.parentElement;el;el=el.parentElement){
      const style=getComputedStyle(el);if(!/(auto|scroll)/.test(style.overflow+style.overflowX+style.overflowY))continue;
      const box=a.element.getBoundingClientRect();
      el.scrollLeft+=box.left+a.u*box.width-a.x;
      el.scrollTop+=box.top+a.v*box.height-a.y;
    }
  },[zoom]);
  // Reserve trailing pan space as the diagram grows. Without it a diagram that
  // initially fits the pane cannot scroll far enough to keep the cursor anchor.
  return <div ref={ref} className="zoom-surface" style={{width:'100%',boxSizing:'content-box',paddingRight:reflow?0:Math.max(0,zoom-1)*650}}>{children}</div>;
}
