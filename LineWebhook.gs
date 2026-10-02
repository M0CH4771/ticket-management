/* Receives the verified group ID forwarded by line-webhook/worker.js.
 * LINE_CHANNEL_SECRET stays in Cloudflare; the shared forwarding secret is
 * stored only in the GAS Script Properties and the Worker secret bindings.
 */
function doPost(e) {
  try {
    const raw=e?.postData?.contents||'';
    if(!raw||raw.length>5000)return lineWebhookJson_({ok:false,error:'invalid_body'});
    const input=JSON.parse(raw),p=PropertiesService.getScriptProperties();
    const expected=p.getProperty('LINE_WEBHOOK_SHARED_SECRET')||'';
    if(input?.kind!=='line_group_join'||expected.length<32||!lineWebhookSecretMatches_(expected,input.secret))
      return lineWebhookJson_({ok:false,error:'unauthorized'});
    if(typeof input.groupId!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(input.groupId))
      return lineWebhookJson_({ok:false,error:'invalid_group'});
    const lock=LockService.getScriptLock();lock.waitLock(10000);
    try {
      const current=p.getProperty('LINE_GROUP_ID')||'';
      if(current&&current!==input.groupId)return lineWebhookJson_({ok:false,error:'group_already_set'});
      if(!current)p.setProperty('LINE_GROUP_ID',input.groupId);
      return lineWebhookJson_({ok:true,accepted:true});
    } finally {lock.releaseLock();}
  } catch(error) {
    return lineWebhookJson_({ok:false,error:'invalid_request'});
  }
}
function lineWebhookSecretMatches_(expected,received) {
  if(typeof received!=='string'||received.length!==expected.length)return false;
  let different=0;
  for(let i=0;i<expected.length;i++)different|=expected.charCodeAt(i)^received.charCodeAt(i);
  return different===0;
}
function lineWebhookJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
