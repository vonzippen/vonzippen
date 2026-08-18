const CONFIG = {
  GITHUB_OWNER: 'vonzippen',
  GITHUB_REPO: 'vonzippen',
  GITHUB_BRANCH: 'main',
  GITHUB_DIR: 'images/on-stage',
  DRIVE_FOLDER_ID: '1_lezjsTrEVMUnefn5aQPIAUQHhGH7W6F',
  GITHUB_TOKEN_PROPERTY: 'GITHUB_TOKEN',
  SYNC_PROPERTY: 'ON_STAGE_SYNC_STATE',
  CHUNK_SIZE: 4
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Von Zippen — On Stage Sync')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setGithubToken(githubToken) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.GITHUB_TOKEN_PROPERTY, githubToken.trim());
  return 'GitHub token saved.';
}

function getStatus() {
  return {
    driveConfigured: !!CONFIG.DRIVE_FOLDER_ID,
    githubConfigured: !!PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY),
    syncInProgress: !!PropertiesService.getScriptProperties().getProperty(CONFIG.SYNC_PROPERTY)
  };
}

function startSync() {
  const token = getToken();
  const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  const driveFiles = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const file = it.next();
    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.getMimeType())) {
      driveFiles.push({name: cleanName(file.getName()), id: file.getId(), size: file.getSize(), md5: file.getMd5Checksum() || ''});
    }
  }
  driveFiles.sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true, sensitivity:'base'}));

  const githubFiles = listGithubFiles(token);
  const githubByName = {};
  githubFiles.forEach(f => githubByName[f.name] = {sha:f.sha, size:f.size});

  const state = {
    files: driveFiles,
    githubByName,
    index: 0,
    removed: Object.keys(githubByName).filter(name => !driveFiles.some(f => f.name === name)),
    removedIndex: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    removedCount: 0,
    manifest: driveFiles.map(f => f.name),
    phase: 'files'
  };
  PropertiesService.getScriptProperties().setProperty(CONFIG.SYNC_PROPERTY, JSON.stringify(state));
  return {total: driveFiles.length};
}

function syncNextChunk() {
  const token = getToken();
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(CONFIG.SYNC_PROPERTY);
  if (!raw) return {done:true, message:'No sync in progress.'};
  const state = JSON.parse(raw);
  let processed = 0;

  if (state.phase === 'files') {
    while (state.index < state.files.length && processed < CONFIG.CHUNK_SIZE) {
      const item = state.files[state.index++];
      const existing = state.githubByName[item.name];
      const file = DriveApp.getFileById(item.id);
      const blob = file.getBlob();
      const gitSha = gitBlobSha(blob.getBytes());
      if (existing && existing.sha === gitSha) {
        state.skipped++;
      } else {
        putGithubFile(token, item.name, blob, existing ? existing.sha : null, existing ? 'Update On Stage photo' : 'Add On Stage photo');
        if (existing) state.updated++; else state.added++;
      }
      processed++;
    }
    if (state.index >= state.files.length) state.phase = 'removed';
  }

  if (state.phase === 'removed' && processed < CONFIG.CHUNK_SIZE) {
    while (state.removedIndex < state.removed.length && processed < CONFIG.CHUNK_SIZE) {
      const name = state.removed[state.removedIndex++];
      const file = state.githubByName[name];
      if (file) {
        deleteGithubFile(token, name, file.sha);
        state.removedCount++;
      }
      processed++;
    }
    if (state.removedIndex >= state.removed.length) state.phase = 'manifest';
  }

  if (state.phase === 'manifest') {
    putGithubText(token, 'images/on-stage.json', JSON.stringify({images: state.manifest}, null, 2) + '\n', getGithubFileSha(token, 'images/on-stage.json'), 'Update On Stage image manifest');
    state.phase = 'done';
  }

  const done = state.phase === 'done';
  const result = {
    done,
    processed,
    total: state.files.length,
    current: Math.min(state.index, state.files.length),
    added: state.added,
    updated: state.updated,
    skipped: state.skipped,
    removed: state.removedCount
  };
  if (done) props.deleteProperty(CONFIG.SYNC_PROPERTY); else props.setProperty(CONFIG.SYNC_PROPERTY, JSON.stringify(state));
  return result;
}

function cancelSync() {
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.SYNC_PROPERTY);
  return 'Sync cancelled.';
}

function getToken() {
  const token = PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);
  if (!token) throw new Error('Setup is incomplete. Add the GitHub token first.');
  return token;
}

function cleanName(name) { return name.trim().replace(/[\\/:*?"<>|]/g, '-'); }

function gitBlobSha(bytes) {
  const header = Utilities.newBlob('blob ' + bytes.length + '\x00').getBytes();
  const data = header.concat(bytes);
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, data);
  return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function githubUrl(path) {
  return 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
}

function githubRequest(url, token, options) {
  const base = {method:'get', muteHttpExceptions:true, headers:{Authorization:'Bearer ' + token, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28'}};
  Object.assign(base, options || {});
  const res = UrlFetchApp.fetch(url, base), code = res.getResponseCode(), text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error('GitHub API ' + code + ': ' + text.slice(0, 500));
  return text ? JSON.parse(text) : {};
}

function listGithubFiles(token) {
  try { const data = githubRequest(githubUrl(CONFIG.GITHUB_DIR), token); return Array.isArray(data) ? data.filter(x => x.type === 'file') : []; }
  catch(e) { if (String(e).indexOf('404') >= 0) return []; throw e; }
}

function getGithubFileSha(token, path) {
  try { return githubRequest(githubUrl(path), token).sha || null; }
  catch(e) { if (String(e).indexOf('404') >= 0) return null; throw e; }
}

function putGithubFile(token, name, blob, sha, message) {
  const path = CONFIG.GITHUB_DIR + '/' + encodeURIComponent(name).replace(/%2F/g, '/');
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  const payload = {message, content:Utilities.base64Encode(blob.getBytes()), branch:CONFIG.GITHUB_BRANCH};
  if (sha) payload.sha = sha;
  githubRequest(url, token, {method:'put', contentType:'application/json', payload:JSON.stringify(payload)});
}

function putGithubText(token, path, text, sha, message) {
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  const payload = {message, content:Utilities.base64Encode(text, Utilities.Charset.UTF_8), branch:CONFIG.GITHUB_BRANCH};
  if (sha) payload.sha = sha;
  githubRequest(url, token, {method:'put', contentType:'application/json', payload:JSON.stringify(payload)});
}

function deleteGithubFile(token, name, sha) {
  const path = CONFIG.GITHUB_DIR + '/' + encodeURIComponent(name).replace(/%2F/g, '/');
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  githubRequest(url, token, {method:'delete', contentType:'application/json', payload:JSON.stringify({message:'Remove deleted On Stage photo', sha, branch:CONFIG.GITHUB_BRANCH})});
}
