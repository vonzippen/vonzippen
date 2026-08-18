const CONFIG = {
  GITHUB_OWNER: 'vonzippen',
  GITHUB_REPO: 'vonzippen',
  GITHUB_BRANCH: 'main',
  GITHUB_DIR: 'images/on-stage',
  DRIVE_FOLDER_ID: '1_lezjsTrEVMUnefn5aQPIAUQHhGH7W6F',
  GITHUB_TOKEN_PROPERTY: 'GITHUB_TOKEN',
  SYNC_STATE_PROPERTY: 'SYNC_STATE',
  LAST_SYNC_PROPERTY: 'LAST_SYNC',
  BACKGROUND_TRIGGER_FUNCTION: 'backgroundSyncWorker'
};

function getStatus() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(CONFIG.SYNC_STATE_PROPERTY);
  var lastRaw = props.getProperty(CONFIG.LAST_SYNC_PROPERTY);
  var status = {driveConfigured:!!CONFIG.DRIVE_FOLDER_ID,githubConfigured:!!props.getProperty(CONFIG.GITHUB_TOKEN_PROPERTY),syncing:!!raw,progress:null,lastSync:lastRaw?JSON.parse(lastRaw):null};
  if(raw){var state=JSON.parse(raw);status.progress={processed:state.index,total:state.items.length,added:state.added,updated:state.updated,skipped:state.skipped,removed:state.removed,background:!!state.background};}
  return status;
}

function doGet(e){var auto=e&&e.parameter&&e.parameter.sync==='1';var msg='';if(auto){try{var r=startBackgroundSync();msg=r.alreadyRunning?'A sync is already running.':'Background sync started — '+r.total+' photos found.';}catch(err){msg='Error: '+err.message;}}var t=HtmlService.createTemplateFromFile('Index');t.autoSyncMessage=msg;return t.evaluate().setTitle('Von Zippen — On Stage Sync').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);}
function setGithubToken(token){if(!token||!token.trim())throw new Error('GitHub token is empty.');PropertiesService.getScriptProperties().setProperty(CONFIG.GITHUB_TOKEN_PROPERTY,token.trim());return 'GitHub token saved.';}
function startSync(){return initializeSync(false);}
function startBackgroundSync(){var raw=PropertiesService.getScriptProperties().getProperty(CONFIG.SYNC_STATE_PROPERTY);if(raw){var s=JSON.parse(raw);return{alreadyRunning:true,total:s.items.length};}var r=initializeSync(true);scheduleBackgroundWorker();return{alreadyRunning:false,total:r.total};}
function initializeSync(background){var token=PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);if(!token)throw new Error('GitHub token is not configured.');var folder=DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID),items=[],files=folder.getFiles();while(files.hasNext()){var f=files.next();if(/^image\/(jpeg|png|webp|gif)$/i.test(f.getMimeType()))items.push({id:f.getId(),name:cleanName(f.getName())});}items.sort(function(a,b){return a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'});});var gh={};listGithubFiles(token).forEach(function(f){gh[f.name]={sha:f.sha};});saveState({index:0,items:items,githubByName:gh,remainingDeletes:null,deleteIndex:0,manifest:[],added:0,updated:0,skipped:0,removed:0,background:!!background,startedAt:new Date().toISOString()});return{total:items.length};}
function syncNextChunk(){return processOneItem();}
function backgroundSyncWorker(){var lock=LockService.getScriptLock();if(!lock.tryLock(5000)){scheduleBackgroundWorker();return;}try{clearBackgroundTriggers();var raw=PropertiesService.getScriptProperties().getProperty(CONFIG.SYNC_STATE_PROPERTY);if(!raw)return;var r=processOneItem();if(!r.done)scheduleBackgroundWorker();}finally{lock.releaseLock();}}
function processOneItem(){var token=PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY),raw=PropertiesService.getScriptProperties().getProperty(CONFIG.SYNC_STATE_PROPERTY);if(!token)throw new Error('GitHub token is not configured.');if(!raw)throw new Error('No sync in progress. Press SYNC NOW first.');var s=JSON.parse(raw);if(s.index<s.items.length){var item=s.items[s.index],existing=s.githubByName[item.name]||null,blob=DriveApp.getFileById(item.id).getBlob(),sha=gitBlobSha1(blob.getBytes());if(existing&&existing.sha===sha)s.skipped++;else{putGithubFile(token,item.name,blob,existing?existing.sha:null,existing?'Update On Stage photo':'Add On Stage photo');if(existing)s.updated++;else s.added++;}s.manifest.push(item.name);delete s.githubByName[item.name];s.index++;saveState(s);return progress(s);}if(s.remainingDeletes===null){s.remainingDeletes=Object.keys(s.githubByName);s.deleteIndex=0;}if(s.deleteIndex<s.remainingDeletes.length){var name=s.remainingDeletes[s.deleteIndex],entry=s.githubByName[name];deleteGithubFile(token,name,entry.sha);s.removed++;s.deleteIndex++;saveState(s);return progress(s);}putGithubText(token,'images/on-stage.json',JSON.stringify({images:s.manifest},null,2)+'\n',getGithubFileSha(token,'images/on-stage.json'),'Update On Stage image manifest');var result={done:true,processed:s.items.length,total:s.items.length,added:s.added,updated:s.updated,skipped:s.skipped,removed:s.removed};PropertiesService.getScriptProperties().setProperty(CONFIG.LAST_SYNC_PROPERTY,JSON.stringify({completedAt:new Date().toISOString(),total:result.total,added:result.added,updated:result.updated,skipped:result.skipped,removed:result.removed}));PropertiesService.getScriptProperties().deleteProperty(CONFIG.SYNC_STATE_PROPERTY);clearBackgroundTriggers();return result;}
function scheduleBackgroundWorker(){clearBackgroundTriggers();ScriptApp.newTrigger(CONFIG.BACKGROUND_TRIGGER_FUNCTION).timeBased().after(1000).create();}
function clearBackgroundTriggers(){ScriptApp.getProjectTriggers().forEach(function(t){if(t.getHandlerFunction()===CONFIG.BACKGROUND_TRIGGER_FUNCTION)ScriptApp.deleteTrigger(t);});}
function progress(s){return{done:false,processed:s.index,total:s.items.length,uploaded:s.index,uploadTotal:s.items.length,added:s.added,updated:s.updated,skipped:s.skipped,removed:s.removed};}
function gitBlobSha1(bytes){var h=Utilities.newBlob('blob '+bytes.length+'\0').getBytes();return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1,h.concat(bytes)));}
function bytesToHex(bytes){return bytes.map(function(b){var n=b<0?b+256:b;return('0'+n.toString(16)).slice(-2);}).join('');}
function saveState(s){PropertiesService.getScriptProperties().setProperty(CONFIG.SYNC_STATE_PROPERTY,JSON.stringify(s));}
function cancelSync(){PropertiesService.getScriptProperties().deleteProperty(CONFIG.SYNC_STATE_PROPERTY);clearBackgroundTriggers();return'Sync cancelled.';}
function cleanName(n){return n.trim().replace(/[\\/:*?"<>|]/g,'-');}
function githubUrl(path){return'https://api.github.com/repos/'+CONFIG.GITHUB_OWNER+'/'+CONFIG.GITHUB_REPO+'/contents/'+path.split('/').map(encodeURIComponent).join('/')+'?ref='+encodeURIComponent(CONFIG.GITHUB_BRANCH);}
function githubRequest(url,token,options){var base={method:'get',muteHttpExceptions:true,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}};Object.assign(base,options||{});var response=UrlFetchApp.fetch(url,base),code=response.getResponseCode(),text=response.getContentText();if(code<200||code>=300)throw new Error('GitHub API '+code+': '+text.slice(0,500));return text?JSON.parse(text):{};}
function listGithubFiles(token){try{var d=githubRequest(githubUrl(CONFIG.GITHUB_DIR),token);return Array.isArray(d)?d.filter(function(x){return x.type==='file';}):[];}catch(e){if(String(e).indexOf('404')>=0)return[];throw e;}}
function getGithubFileSha(token,path){try{return githubRequest(githubUrl(path),token).sha||null;}catch(e){if(String(e).indexOf('404')>=0)return null;throw e;}}
function putGithubFile(token,name,blob,sha,message){var path=CONFIG.GITHUB_DIR+'/'+encodeURIComponent(name).replace(/%2F/g,'/'),url='https://api.github.com/repos/'+CONFIG.GITHUB_OWNER+'/'+CONFIG.GITHUB_REPO+'/contents/'+path+'?ref='+encodeURIComponent(CONFIG.GITHUB_BRANCH),p={message:message,content:Utilities.base64Encode(blob.getBytes()),branch:CONFIG.GITHUB_BRANCH};if(sha)p.sha=sha;githubRequest(url,token,{method:'put',contentType:'application/json',payload:JSON.stringify(p)});}
function putGithubText(token,path,text,sha,message){var url='https://api.github.com/repos/'+CONFIG.GITHUB_OWNER+'/'+CONFIG.GITHUB_REPO+'/contents/'+path+'?ref='+encodeURIComponent(CONFIG.GITHUB_BRANCH),p={message:message,content:Utilities.base64Encode(text,Utilities.Charset.UTF_8),branch:CONFIG.GITHUB_BRANCH};if(sha)p.sha=sha;githubRequest(url,token,{method:'put',contentType:'application/json',payload:JSON.stringify(p)});}
function deleteGithubFile(token,name,sha){var path=CONFIG.GITHUB_DIR+'/'+encodeURIComponent(name).replace(/%2F/g,'/'),url='https://api.github.com/repos/'+CONFIG.GITHUB_OWNER+'/'+CONFIG.GITHUB_REPO+'/contents/'+path+'?ref='+encodeURIComponent(CONFIG.GITHUB_BRANCH);githubRequest(url,token,{method:'delete',contentType:'application/json',payload:JSON.stringify({message:'Remove deleted On Stage photo',sha:sha,branch:CONFIG.GITHUB_BRANCH})});}
