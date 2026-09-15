export class ViewerAgents {
  constructor(select) {
    this.select=select;
    this.latest=document.createElement('button');
    this.latest.id='last-agent-activity';
    this.latest.hidden=true;
    this.latest.style.cssText='position:fixed;right:12px;bottom:12px;z-index:25;max-width:min(330px,70vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:9px 12px;border:1px solid #a4c9e9;border-radius:12px;background:#eef7ff;color:#25445d;font:13px system-ui';
    document.body.append(this.latest);
    this.panel=document.createElement('details');
    this.panel.id='agent-tabs';
    const summary=document.createElement('summary');summary.textContent='Recent agent tabs';
    this.rows=document.createElement('div');this.rows.style.cssText='display:grid;gap:6px;padding:8px 0';
    this.panel.append(summary,this.rows);
    document.getElementById('viewer-toolbar').append(this.panel);
    setInterval(()=>{if(this.state)this.update(this.state);},15000);
  }
  update(state) {
    this.state=state;
    const entries=(state.agents || []).map(a=>({...a,page:state.tabs.find(t=>t.id===a.tab)})).filter(a=>a.page);
    this.latest.hidden=this.panel.hidden=!entries.length;
    this.rows.replaceChildren();
    for(const [index,a] of entries.entries()){
      const seconds=Math.max(0,Math.floor((Date.now()-a.at)/1000));
      const age=seconds<60?'just now':Math.floor(seconds/60)+'m ago';
      const title=a.page.title || a.page.url;
      const label=`${a.agent} · ${a.kind==='reading'?'reading':'working'} · ${title} · ${age}`;
      const button=document.createElement('button');button.textContent=label;button.title=a.page.url;
      button.onclick=()=>this.select(a.tab);button.style.textAlign='left';this.rows.append(button);
      if(index===0){this.latest.textContent='Last: '+a.agent+' · '+title;this.latest.title=label+' — show this tab';this.latest.onclick=()=>this.select(a.tab);}
    }
  }
}
