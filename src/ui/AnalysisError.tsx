import React from 'react';
export function analysisErrorMessage(error:string){
  if(/input_too_large|Input exceeds the maximum length/.test(error))return '分析请求过长，Agent 在读取源码前拒绝了任务。请使用新版重新分析；原失败记录已保留。';
  if(/invalid_json_schema|Invalid schema for response_format/.test(error))return 'Arc 与 Agent 的结果格式不兼容，分析未能启动。技术记录已保留。';
  if(/超过 600 秒执行预算/.test(error))return '这次任务被旧版 Arc 的 10 分钟总时限停止，未得到可保存的完整结果。新版已取消该总时限；可重新分析，原失败记录保留。';
  if(/Reconnecting|request timed out|stream disconnected|waiting for network/i.test(error))return 'Agent 连接中断或请求超时，本次分析未完成。原任务与错误记录已保留。';
  if(error.startsWith('结果校验失败'))return 'Agent 已返回内容，但没有通过结果校验，因此未保存为正式说明。可展开技术记录核对原因；原有结果保留。';
  return error.length>180?'分析未完成。可展开技术记录查看原因，已有说明仍保留。':error;
}
export function AnalysisError({error}:{error:string}){
  const message=analysisErrorMessage(error);
  return <div className="analysis-error"><p className="warning">{message}</p>{message!==error&&<details><summary>技术错误记录</summary><pre>{error}</pre></details>}</div>;
}
