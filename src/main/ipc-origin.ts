export function matchesUiUrl(frameUrl:string,ui:string,platform=process.platform):boolean {
  const normalize=(url:string)=>url.replace(/^file:\/\/\/[a-zA-Z]:\//,prefix=>prefix.toLowerCase());
  const documentUrl = frameUrl.split(/[?#]/, 1)[0];
  return platform==='win32'?normalize(documentUrl)===normalize(ui):documentUrl===ui;
}
