const CONFIG = {
  GITHUB_OWNER: 'vonzippen',
  GITHUB_REPO: 'vonzippen',
  GITHUB_BRANCH: 'main',
  GITHUB_DIR: 'images/on-stage',
  DRIVE_FOLDER_ID: '1TeUk6t6WDqoY2p9D7Mjb2tY5rIXlUBCY',
  GITHUB_TOKEN_PROPERTY: 'GITHUB_TOKEN',
  SYNC_STATE_PROPERTY: 'SYNC_STATE',
  LAST_SYNC_PROPERTY: 'LAST_SYNC',
  LAST_ERROR_PROPERTY: 'LAST_SYNC_ERROR',
  CHUNK_SIZE: 786432
};

function doGet(e) {
  var autoSync = e && e.parameter && e.parameter.sync === '1';
  var autoSyncMessage = '';
  if (autoSync) {
    try {
      var result = startSync();
      autoSyncMessage = result.alreadyRunning
        ? 'A sync is already running.'
        : 'Sync ready — ' + result.total + ' photos found.';
    } catch (err) {
      autoSyncMessage = 'Error: ' + err.message;
    }
  }
  var template = HtmlService.createTemplateFromFile('Index');
  template.autoSyncMessage = autoSyncMessage;
  return template.evaluate()
    .setTitle('Von Zippen — On Stage Sync')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setGithubToken(token) {
  if (!token || !token.trim()) throw new Error('GitHub token is empty.');
  PropertiesService.getScriptProperties().setProperty(CONFIG.GITHUB_TOKEN_PROPERTY, token.trim());
  return 'GitHub token saved.';
}

function getStatus() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(CONFIG.SYNC_STATE_PROPERTY);
  var lastRaw = props.getProperty(CONFIG.LAST_SYNC_PROPERTY);
  var state = raw ? JSON.parse(raw) : null;
  return {
    driveConfigured: !!CONFIG.DRIVE_FOLDER_ID,
    githubConfigured: !!props.getProperty(CONFIG.GITHUB_TOKEN_PROPERTY),
    syncing: !!state && state.version === 2,
    progress: state && state.version === 2 ? {
      phase: state.phase,
      processed: state.index,
      total: state.items.length,
      added: state.added,
      updated: state.updated,
      skipped: state.skipped,
      removed: state.removed
    } : null,
    lastSync: lastRaw ? JSON.parse(lastRaw) : null,
    lastError: props.getProperty(CONFIG.LAST_ERROR_PROPERTY) ||
      (state && state.version !== 2 ? 'An older incomplete sync was found. Press SYNC NOW to restart safely.' : '')
  };
}

function startSync() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(CONFIG.GITHUB_TOKEN_PROPERTY)) {
    throw new Error('GitHub token is not configured.');
  }
  var raw = props.getProperty(CONFIG.SYNC_STATE_PROPERTY);
  if (raw) {
    var existing = JSON.parse(raw);
    if (existing.version === 2) {
      props.deleteProperty(CONFIG.LAST_ERROR_PROPERTY);
      return { alreadyRunning: true, total: existing.items.length };
    }
  }
  props.deleteProperty(CONFIG.SYNC_STATE_PROPERTY);
  props.deleteProperty(CONFIG.LAST_ERROR_PROPERTY);
  removeWorkerTriggers();

  var folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  var items = [];
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.getMimeType())) {
      items.push({
        id: file.getId(),
        name: cleanName(file.getName()),
        mime: file.getMimeType(),
        size: file.getSize()
      });
    }
  }
  items.sort(function(a, b) {
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  var token = props.getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);
  var githubByName = {};
  listGithubFiles(token).forEach(function(file) {
    githubByName[file.name] = { sha: file.sha };
  });

  var state = {
    version: 2,
    phase: 'upload',
    index: 0,
    items: items,
    githubByName: githubByName,
    manifest: [],
    added: 0,
    updated: 0,
    skipped: 0,
    removed: 0,
    startedAt: new Date().toISOString()
  };
  saveState(state);
  return { alreadyRunning: false, total: items.length };
}

function getPhotoInfo(index) {
  var state = getSyncState();
  var item = state.items[index];
  if (!item || index !== state.index || state.phase !== 'upload') {
    throw new Error('Invalid photo request. Please restart the sync.');
  }
  return { name: item.name, mime: item.mime, size: item.size };
}

function getPhotoChunk(index, offset) {
  var state = getSyncState();
  var item = state.items[index];
  if (!item || index !== state.index || state.phase !== 'upload') {
    throw new Error('Invalid photo request. Please restart the sync.');
  }
  var blob = DriveApp.getFileById(item.id).getBlob();
  var bytes = blob.getBytes();
  var start = Number(offset) || 0;
  if (start < 0 || start >= bytes.length) {
    if (start === 0 && bytes.length === 0) return '';
    throw new Error('Invalid photo data offset.');
  }
  return Utilities.base64Encode(bytes.slice(start, Math.min(start + CONFIG.CHUNK_SIZE, bytes.length)));
}

function uploadOptimizedPhoto(index, base64, mime) {
  var state = getSyncState();
  var item = state.items[index];
  if (!item || index !== state.index || state.phase !== 'upload') {
    throw new Error('Invalid photo upload. Please restart the sync.');
  }
  var isGif = item.mime === 'image/gif';
  var outputName = isGif ? item.name : jpegName(item.name);
  var outputMime = isGif ? 'image/gif' : 'image/jpeg';
  if (mime !== outputMime) throw new Error('Unexpected image format for ' + item.name + '.');

  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, outputMime, outputName);
  var existing = state.githubByName[outputName] || null;
  putGithubFile(
    PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY),
    outputName,
    blob,
    existing ? existing.sha : null,
    existing ? 'Update On Stage photo' : 'Add On Stage photo'
  );
  if (existing) state.updated++;
  else state.added++;
  delete state.githubByName[outputName];
  state.manifest.push(outputName);
  state.index++;
  saveState(state);
  return getProgress(state);
}

function finishUploads() {
  var state = getSyncState();
  if (state.phase !== 'upload' || state.index !== state.items.length) {
    throw new Error('Not all photos have been uploaded yet.');
  }
  var token = PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);
  putGithubText(
    token,
    'images/on-stage.json',
    JSON.stringify({ images: state.manifest }, null, 2) + '\\n',
    getGithubFileSha(token, 'images/on-stage.json'),
    'Update On Stage image manifest'
  );
  state.phase = 'delete';
  saveState(state);
  return getProgress(state);
}

function deleteNextOldPhoto() {
  var state = getSyncState();
  if (state.phase !== 'delete') throw new Error('Uploads are not complete.');
  var names = Object.keys(state.githubByName);
  if (names.length) {
    var name = names[0];
    var entry = state.githubByName[name];
    deleteGithubFile(
      PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY),
      name,
      entry.sha
    );
    delete state.githubByName[name];
    state.removed++;
    saveState(state);
    return getProgress(state);
  }

  var result = {
    total: state.items.length,
    added: state.added,
    updated: state.updated,
    skipped: state.skipped,
    removed: state.removed,
    completedAt: new Date().toISOString()
  };
  var props = PropertiesService.getScriptProperties();
  props.setProperty(CONFIG.LAST_SYNC_PROPERTY, JSON.stringify(result));
  props.deleteProperty(CONFIG.SYNC_STATE_PROPERTY);
  props.deleteProperty(CONFIG.LAST_ERROR_PROPERTY);
  return { done: true, result: result };
}

function cancelSync() {
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.SYNC_STATE_PROPERTY);
  removeWorkerTriggers();
  return 'Sync cancelled. Already uploaded files were left untouched.';
}

function getSyncState() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.SYNC_STATE_PROPERTY);
  if (!raw) throw new Error('No sync is currently active.');
  var state = JSON.parse(raw);
  if (state.version !== 2) throw new Error('An older sync state was found. Cancel it and start again.');
  return state;
}

function getProgress(state) {
  return {
    done: false,
    phase: state.phase,
    processed: state.index,
    total: state.items.length,
    added: state.added,
    updated: state.updated,
    skipped: state.skipped,
    removed: state.removed,
    remainingDeletes: Object.keys(state.githubByName).length
  };
}

function recordSyncError(err) {
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.LAST_ERROR_PROPERTY,
    new Date().toISOString() + ' — ' + (err && err.message ? err.message : String(err))
  );
}

function saveState(state) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.SYNC_STATE_PROPERTY, JSON.stringify(state));
}

function removeWorkerTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'backgroundSyncWorker') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function cleanName(name) {
  return name.trim().replace(/[\\/:*?"<>|]/g, '-');
}

function jpegName(name) {
  return name.replace(/\.(png|webp)$/i, '.jpg');
}

function githubUrl(path) {
  return 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO +
    '/contents/' + path.split('/').map(encodeURIComponent).join('/') +
    '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
}

function githubRequest(url, token, options) {
  var base = {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  };
  Object.assign(base, options || {});
  var response = UrlFetchApp.fetch(url, base);
  var code = response.getResponseCode();
  var responseText = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('GitHub API ' + code + ': ' + responseText.slice(0, 500));
  }
  return responseText ? JSON.parse(responseText) : {};
}

function listGithubFiles(token) {
  try {
    var data = githubRequest(githubUrl(CONFIG.GITHUB_DIR), token);
    return Array.isArray(data) ? data.filter(function(x) { return x.type === 'file'; }) : [];
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
  var path = CONFIG.GITHUB_DIR + '/' + encodeURIComponent(name).replace(/%2F/g, '/');
  var url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO +
    '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  var payload = {
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

function putGithubText(token, path, content, sha, message) {
  var url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO +
    '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  var payload = {
    message: message,
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
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
  var path = CONFIG.GITHUB_DIR + '/' + encodeURIComponent(name).replace(/%2F/g, '/');
  var url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO +
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
