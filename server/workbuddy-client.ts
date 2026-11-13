/**
 * Trusted-server component, deliberately excluded from the desktop bundle.
 * Official source: https://open.workbuddy.cn/docs/openapi (2026-10-20).
 * No OAuth client secret or refresh token is accepted by the renderer.
 * Arc does NOT enable desktop dispatch until workspace/read-only isolation
 * can be proven for the authorized local assistant.
 */
export class WorkBuddyClient {
  constructor(private readonly token:()=>Promise<string>,private readonly transport:typeof fetch=fetch){}
  private async request(endpoint:string,body?:unknown){
    const token=await this.token();
    if(!token)throw new Error('WorkBuddy OAuth authorization missing');
    const response=await this.transport(`https://www.workbuddy.cn/openapi/v2/${endpoint}`,{
      method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    if(!response.ok)throw new Error(`WorkBuddy HTTP ${response.status}; response body withheld`);
    const text=await response.text();if(Buffer.byteLength(text)>2*1024*1024)throw new Error('WorkBuddy response too large');
    const result=JSON.parse(text);
    if(result.code!==0)throw new Error(`WorkBuddy business error code=${Number.isFinite(result.code)?result.code:'invalid'}; request_id=${String(result.request_id||'').replace(/[^\w-]/g,'').slice(0,100)}`);
    return result.data;
  }
  async status(){const data=await this.request('localassistant');if(typeof data?.online!=='boolean')throw new Error('Invalid WorkBuddy status schema');return {online:data.online,workspaceBinding:'unverified' as const};}
  async messagesAfter(messageId:string){
    if(!messageId||messageId.length>200)throw new Error('Invalid message ID');
    const data=await this.request(`localassistant/message?message_id=${encodeURIComponent(messageId)}`);
    if(!Array.isArray(data?.messages))throw new Error('Invalid WorkBuddy history schema');
    return data.messages;
  }
  // This low-level transport is not exposed through desktop IPC. A production
  // deployment must first supply approved OAuth, verified workspace isolation,
  // and correlation between responses and the immutable Arc binding.
  async sendMessage(content:string){
    if(!content||content.length>100000)throw new Error('Invalid WorkBuddy message');
    const data=await this.request('localassistant/message',{content,msg_type:'text'});
    if(typeof data?.message_id!=='string'||!data.message_id)throw new Error('Missing WorkBuddy message identity');
    return {message_id:data.message_id,remote_status:'submitted' as const};
  }
}
