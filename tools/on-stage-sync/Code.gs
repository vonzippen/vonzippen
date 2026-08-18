const CONFIG = {
  GITHUB_OWNER: 'vonzippen',
  GITHUB_REPO: 'vonzippen',
  GITHUB_BRANCH: 'main',
  GITHUB_DIR: 'images/on-stage',
  DRIVE_FOLDER_PROPERTY: 'ON_STAGE_DRIVE_FOLDER_ID',
  GITHUB_TOKEN_PROPERTY: 'GITHUB_TOKEN'
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Von Zippen — On Stage Sync')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setSetupProperties(driveFolderId, githubToken) {
  PropertiesService.getScriptProperties().setProperties({
    [CONFIG.DRIVE_FOLDER_PROPERTY]: driveFolderId.trim(),
    [CONFIG.GITHUB_TOKEN_PROPERTY]: githubToken.trim()
  }, true);
  return 'Setup saved.';
}

function getStatus() {
  const props = PropertiesService.getScriptProperties();
  return {
    driveConfigured: !!props.getProperty(CONFIG.DRIVE_FOLDER_PROPERTY),
    githubConfigured: !!props.getProperty(CONFIG.GITHUB_TOKEN_PROPERTY)
  };
}

function syncOnStage() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty(CONFIG.DRIVE_FOLDER_PROPERTY);
  const token = props.getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);
  if (!folderId || !token) throw new Error('Setup is incomplete. Add the Drive folder ID and GitHub token first.');

  const folder = DriveApp.getFolderById(folderId);
  const driveFiles = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const file = it.next();
    const mime = file.getMimeType();
    if (/^image\/(jpeg|png|webp|gif)$/i.test(mime)) {
      driveFiles.push({name: cleanName(file.getName()), file});
    }
  }

  const githubFiles = listGithubFiles(token);
  const githubByName = {};
  githubFiles.forEach(f => githubByName[f.name] = f);

  let added = 0, updated = 0, removed = 0;
  const manifest = [];
  driveFiles.sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true, sensitivity:'base'}));

  driveFiles.forEach(item => {
    const existing = githubByName[item.name];
    putGithubFile(token, item.name, item.file.getBlob(), existing ? existing.sha : null,
      existing ? 'Update On Stage photo' : 'Add On Stage photo');
    if (existing) updated++; else added++;
    manifest.push(item.name);
    delete githubByName[item.name];
  });

  Object.keys(githubByName).forEach(name => {
    deleteGithubFile(token, name, githubByName[name].sha);
    removed++;
  });

  putGithubText(token, 'images/on-stage.json', JSON.stringify({images: manifest}, null, 2) + '\n',
    getGithubFileSha(token, 'images/on-stage.json'), 'Update On Stage image manifest');

  return {added, updated, removed, total: manifest.length};
}

function cleanName(name) {
  return name.trim().replace(/[\\/:*?"<>|]/g, '-');
}

function githubUrl(path) {
  return 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
}

function githubRequest(url, token, options) {
  const base = {
    method: 'get',
    muteHttpExceptions: true,
    headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
  };
  Object.assign(base, options || {});
  const res = UrlFetchApp.fetch(url, base);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error('GitHub API ' + code + ': ' + text.slice(0, 500));
  return text ? JSON.parse(text) : {};
}

function listGithubFiles(token) {
  const url = githubUrl(CONFIG.GITHUB_DIR);
  const data = githubRequest(url, token);
  return Array.isArray(data) ? data.filter(x => x.type === 'file') : [];
}

function getGithubFileSha(token, path) {
  const url = githubUrl(path);
  try { return githubRequest(url, token).sha || null; } catch (e) { if (String(e).indexOf('404') >= 0) return null; throw e; }
}

function putGithubFile(token, name, blob, sha, message) {
  const path = CONFIG.GITHUB_DIR + '/' + encodeURIComponent(name).replace(/%2F/g, '/');
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  const payload = {message, content: Utilities.base64Encode(blob.getBytes()), branch: CONFIG.GITHUB_BRANCH};
  if (sha) payload.sha = sha;
  githubRequest(url, token, {method:'put', contentType:'application/json', payload:JSON.stringify(payload)});
}

function putGithubText(token, path, text, sha, message) {
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  const payload = {message, content: Utilities.base64Encode(text, Utilities.Charset.UTF_8), branch: CONFIG.GITHUB_BRANCH};
  if (sha) payload.sha = sha;
  githubRequest(url, token, {method:'put', contentType:'application/json', payload:JSON.stringify(payload)});
}

function deleteGithubFile(token, name, sha) {
  const path = CONFIG.GITHUB_DIR + '/' + encodeURIComponent(name).replace(/%2F/g, '/');
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  githubRequest(url, token, {method:'delete', contentType:'application/json', payload:JSON.stringify({message:'Remove deleted On Stage photo', sha, branch:CONFIG.GITHUB_BRANCH})});
}
