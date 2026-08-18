const CONFIG = {
  GITHUB_OWNER: 'vonzippen',
  GITHUB_REPO: 'vonzippen',
  GITHUB_BRANCH: 'main',
  GITHUB_DIR: 'images/on-stage',
  DRIVE_FOLDER_ID: '1_lezjsTrEVMUnefn5aQPIAUQHhGH7W6F',
  GITHUB_TOKEN_PROPERTY: 'GITHUB_TOKEN',
  SYNC_STATE_PROPERTY: 'SYNC_STATE'
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Von Zippen — On Stage Sync')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setGithubToken(token) {
  if (!token || !token.trim()) throw new Error('GitHub token is empty.');
  PropertiesService.getScriptProperties().setProperty(CONFIG.GITHUB_TOKEN_PROPERTY, token.trim());
  return 'GitHub token saved.';
}

function getStatus() {
  return {
    driveConfigured: !!CONFIG.DRIVE_FOLDER_ID,
    githubConfigured: !!PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY),
    syncing: !!PropertiesService.getScriptProperties().getProperty(CONFIG.SYNC_STATE_PROPERTY)
  };
}

// Starts a sync and stores all state in Script Properties. Each subsequent
// syncNextChunk() call handles ONE photo, so no single Apps Script execution
// has to process the whole folder.
function startSync() {
  const token = PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);
  if (!token) throw new Error('GitHub token is not configured.');

  const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  const items = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const file = it.next();
    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.getMimeType())) {
      items.push({ id: file.getId(), name: cleanName(file.getName()) });
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));

  const githubByName = {};
  listGithubFiles(token).forEach(file => {
    githubByName[file.name] = {sha: file.sha};
  });

  const state = {
    phase: 'upload',
    index: 0,
    deleteIndex: 0,
    items: items,
    githubByName: githubByName,
    remainingDeletes: Object.keys(githubByName),
    manifest: [],
    added: 0,
    updated: 0,
    skipped: 0,
    removed: 0
  };

  PropertiesService.getScriptProperties().setProperty(
    CONFIG.SYNC_STATE_PROPERTY,
    JSON.stringify(state)
  );

  return {total: items.length};
}

// One photo per execution. The browser calls this repeatedly.
function syncNextChunk() {
  const token = PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.SYNC_STATE_PROPERTY);
  if (!token) throw new Error('GitHub token is not configured.');
  if (!raw) throw new Error('No sync in progress. Press SYNC NOW first.');

  const state = JSON.parse(raw);

  if (state.phase === 'upload') {
    if (state.index < state.items.length) {
      const item = state.items[state.index];
      const existing = state.githubByName[item.name] || null;
      const file = DriveApp.getFileById(item.id);
      const blob = file.getBlob();

      // Same filename is treated as the same logical photo. Existing files are
      // updated; new filenames are added. This avoids expensive downloads of
      // every GitHub image while still keeping Drive authoritative.
      putGithubFile(
        token,
        item.name,
        blob,
        existing ? existing.sha : null,
        existing ? 'Update On Stage photo' : 'Add On Stage photo'
      );

      if (existing) state.updated++;
      else state.added++;

      state.manifest.push(item.name);
      delete state.githubByName[item.name];
      state.index++;

      saveState(state);
      return progress(state, false);
    }

    state.phase = 'delete';
    state.remainingDeletes = Object.keys(state.githubByName);
    state.deleteIndex = 0;
    saveState(state);
  }

  if (state.phase === 'delete') {
    if (state.deleteIndex < state.remainingDeletes.length) {
      const name = state.remainingDeletes[state.deleteIndex];
      const entry = state.githubByName[name];
      deleteGithubFile(token, name, entry.sha);
      state.removed++;
      state.deleteIndex++;
      saveState(state);
      return progress(state, false);
    }

    // Only after uploads and deletions are finished do we publish the manifest.
    putGithubText(
      token,
      'images/on-stage.json',
      JSON.stringify({images: state.manifest}, null, 2) + '\n',
      getGithubFileSha(token, 'images/on-stage.json'),
      'Update On Stage image manifest'
    );

    const result = {
      done: true,
      current: state.items.length,
      total: state.items.length,
      added: state.added,
      updated: state.updated,
      skipped: state.skipped,
      removed: state.removed
    };

    PropertiesService.getScriptProperties().deleteProperty(CONFIG.SYNC_STATE_PROPERTY);
    return result;
  }

  throw new Error('Invalid sync state. Press SYNC NOW to start again.');
}

function progress(state, done) {
  return {
    done: done,
    current: state.index + state.deleteIndex,
    total: state.items.length + state.remainingDeletes.length,
    uploaded: state.index,
    uploadTotal: state.items.length,
    removed: state.removed,
    added: state.added,
    updated: state.updated,
    skipped: state.skipped
  };
}

function saveState(state) {
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.SYNC_STATE_PROPERTY,
    JSON.stringify(state)
  );
}

function cancelSync() {
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.SYNC_STATE_PROPERTY);
  return 'Sync cancelled.';
}

function cleanName(name) {
  return name.trim().replace(/[\\/:*?"<>|]/g, '-');
}

function githubUrl(path) {
  return 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO +
    '/contents/' + path.split('/').map(encodeURIComponent).join('/') +
    '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
}

function githubRequest(url, token, options) {
  const base = {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  };
  Object.assign(base, options || {});
  const response = UrlFetchApp.fetch(url, base);
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('GitHub API ' + code + ': ' + text.slice(0, 500));
  }
  return text ? JSON.parse(text) : {};
}

function listGithubFiles(token) {
  try {
    const data = githubRequest(githubUrl(CONFIG.GITHUB_DIR), token);
    return Array.isArray(data) ? data.filter(x => x.type === 'file') : [];
  } catch (e) {
    if (String(e).indexOf('404') >= 0) return [];
    throw e;
  }
}

function getGithubFileSha(token, path) {
  try {
    return githubRequest(githubUrl(path), token).sha || null;
  } catch (e) {
    if (String(e).indexOf('404') >= 0) return null;
    throw e;
  }
}

function putGithubFile(token, name, blob, sha, message) {
  const path = CONFIG.GITHUB_DIR + '/' + encodeURIComponent(name).replace(/%2F/g, '/');
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO +
    '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  const payload = {
    message: message,
    content: Utilities.base64Encode(blob.getBytes()),
    branch: CONFIG.GITHUB_BRANCH
  };
  if (sha) payload.sha = sha;
  githubRequest(url, token, {
    method: 'put',
    contentType: 'application/json',
    payload: JSON.stringify(payload)
  });
}

function putGithubText(token, path, text, sha, message) {
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO +
    '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  const payload = {
    message: message,
    content: Utilities.base64Encode(text, Utilities.Charset.UTF_8),
    branch: CONFIG.GITHUB_BRANCH
  };
  if (sha) payload.sha = sha;
  githubRequest(url, token, {
    method: 'put',
    contentType: 'application/json',
    payload: JSON.stringify(payload)
  });
}

function deleteGithubFile(token, name, sha) {
  const path = CONFIG.GITHUB_DIR + '/' + encodeURIComponent(name).replace(/%2F/g, '/');
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO +
    '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  githubRequest(url, token, {
    method: 'delete',
    contentType: 'application/json',
    payload: JSON.stringify({
      message: 'Remove deleted On Stage photo',
      sha: sha,
      branch: CONFIG.GITHUB_BRANCH
    })
  });
}
