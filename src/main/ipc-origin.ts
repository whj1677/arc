export function matchesUiUrl(frameUrl:string,ui:string,platform=process.platform):boolean {
  const normalize=(url:string)=>url.replace(/^file:\/\/\/[a-zA-Z]:\//,prefix=>prefix.toLowerCase());
  return platform==='win32'?normalize(frameUrl).startsWith(normalize(ui)):frameUrl.startsWith(ui);
}
