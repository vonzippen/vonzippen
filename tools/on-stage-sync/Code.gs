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
  WORKER_FUNCTION: 'backgroundSyncWorker',
  BATCH_SIZE: 1
};

function doGet(e) {
  var autoSync = e && e.parameter && e.parameter.sync === '1';
  var autoSyncMessage = '';
  if (autoSync) {
    try {
      var result = startBackgroundSync();
      autoSyncMessage = result.alreadyRunning
        ? 'A sync is already running.'
        : 'Background sync started — ' + result.total + ' photos found.';
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
  var error = props.getProperty(CONFIG.LAST_ERROR_PROPERTY);
  var status = {
    driveConfigured: !!CONFIG.DRIVE_FOLDER_ID,
    githubConfigured: !!props.getProperty(CONFIG.GITHUB_TOKEN_PROPERTY),
    syncing: !!raw,
    progress: null,
    lastSync: lastRaw ? JSON.parse(lastRaw) : null,
    lastError: error || ''
  };
  if (raw) {
    var state = JSON.parse(raw);
    status.progress = {
      processed: state.index,
      total: state.items.length,
      added: state.added,
      updated: state.updated,
      skipped: state.skipped,
      removed: state.removed,
      background: true
    };
  }
  return status;
}

function startSync() {
  return startBackgroundSync();
}

function startBackgroundSync() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(CONFIG.SYNC_STATE_PROPERTY);
  if (raw) {
    var running = JSON.parse(raw);
    return { alreadyRunning: true, total: running.items.length };
  }
  props.deleteProperty(CONFIG.LAST_ERROR_PROPERTY);
  var initialized = initializeSync();
  processBatch();
  return { alreadyRunning: false, total: initialized.total };
}

function initializeSync() {
  var token = PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);
  if (!token) throw new Error('GitHub token is not configured.');
  var folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  var items = [];
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.getMimeType())) {
      items.push({ id: file.getId(), name: cleanName(file.getName()) });
    }
  }
  items.sort(function(a, b) {
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  var githubByName = {};
  listGithubFiles(token).forEach(function(file) {
    githubByName[file.name] = { sha: file.sha };
  });
  saveState({
    index: 0,
    items: items,
    githubByName: githubByName,
    remainingDeletes: null,
    deleteIndex: 0,
    manifest: [],
    added: 0,
    updated: 0,
    skipped: 0,
    removed: 0,
    startedAt: new Date().toISOString()
  });
  return { total: items.length };
}

function backgroundSyncWorker() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.SYNC_STATE_PROPERTY);
    if (!raw) return;
    processBatch();
  } catch (err) {
    recordSyncError(err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function processBatch() {
  var token = PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.SYNC_STATE_PROPERTY);
  if (!token) throw new Error('GitHub token is not configured.');
  if (!raw) return { done: true };
  var state = JSON.parse(raw);

  if (state.index < state.items.length) {
    processOnePhoto(state, token);
  }

  if (state.index >= state.items.length) {
    if (state.remainingDeletes === null) {
      state.remainingDeletes = Object.keys(state.githubByName);
      state.deleteIndex = 0;
    }
    if (state.deleteIndex < state.remainingDeletes.length) {
      var name = state.remainingDeletes[state.deleteIndex];
      var entry = state.githubByName[name];
      deleteGithubFile(token, name, entry.sha);
      state.removed++;
      state.deleteIndex++;
    }
  }

  saveState(state);

  var finished = state.index >= state.items.length &&
    state.remainingDeletes !== null &&
    state.deleteIndex >= state.remainingDeletes.length;

  if (finished) {
    finalizeSync(state, token);
    return { done: true };
  }

  ensureWorkerTrigger();
  return progress(state);
}

function processOnePhoto(state, token) {
  var item = state.items[state.index];
  var existing = state.githubByName[item.name] || null;
  var blob = DriveApp.getFileById(item.id).getBlob();
  var driveSha = gitBlobSha1(blob.getBytes());
  if (existing && existing.sha === driveSha) {
    state.skipped++;
  } else {
    putGithubFile(token, item.name, blob, existing ? existing.sha : null,
      existing ? 'Update On Stage photo' : 'Add On Stage photo');
    if (existing) state.updated++;
    else state.added++;
  }
  state.manifest.push(item.name);
  delete state.githubByName[item.name];
  state.index++;
}

function finalizeSync(state, token) {
  putGithubText(token, 'images/on-stage.json',
    JSON.stringify({ images: state.manifest }, null, 2) + '\n',
    getGithubFileSha(token, 'images/on-stage.json'),
    'Update On Stage image manifest');
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
  removeWorkerTriggers();
}

function progress(state) {
  return {
    done: false,
    processed: state.index,
    total: state.items.length,
    added: state.added,
    updated: state.updated,
    skipped: state.skipped,
    removed: state.removed
  };
}

function ensureWorkerTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var exists = triggers.some(function(trigger) {
    return trigger.getHandlerFunction() === CONFIG.WORKER_FUNCTION;
  });
  if (!exists) {
    ScriptApp.newTrigger(CONFIG.WORKER_FUNCTION).timeBased().after(5000).create();
  }
}

function removeWorkerTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === CONFIG.WORKER_FUNCTION) ScriptApp.deleteTrigger(trigger);
  });
}

function recordSyncError(err) {
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.LAST_ERROR_PROPERTY,
    new Date().toISOString() + ' — ' + err.message
  );
}

function saveState(state) {
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.SYNC_STATE_PROPERTY,
    JSON.stringify(state)
  );
}

function cancelSync() {
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.SYNC_STATE_PROPERTY);
  removeWorkerTriggers();
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
  var base = {
    method: 'get', muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  };
  Object.assign(base, options || {});
  var response = UrlFetchApp.fetch(url, base);
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('GitHub API ' + code + ': ' + text.slice(0, 500));
  }
  return text ? JSON.parse(text) : {};
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
    method: 'put', contentType: 'application/json', payload: JSON.stringify(payload)
  });
}

function putGithubText(token, path, text, sha, message) {
  var url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO +
    '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  var payload = {
    message: message,
    content: Utilities.base64Encode(text, Utilities.Charset.UTF_8),
    branch: CONFIG.GITHUB_BRANCH
  };
  if (sha) payload.sha = sha;
  githubRequest(url, token, {
    method: 'put', contentType: 'application/json', payload: JSON.stringify(payload)
  });
}

function deleteGithubFile(token, name, sha) {
  var path = CONFIG.GITHUB_DIR + '/' + encodeURIComponent(name).replace(/%2F/g, '/');
  var url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO +
    '/contents/' + path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  githubRequest(url, token, {
    method: 'delete', contentType: 'application/json',
    payload: JSON.stringify({
      message: 'Remove deleted On Stage photo', sha: sha, branch: CONFIG.GITHUB_BRANCH
    })
  });
}

function gitBlobSha1(bytes) {
  var header = Utilities.newBlob('blob ' + bytes.length + '\0').getBytes();
  return bytesToHex(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_1, header.concat(bytes)
  ));
}

function bytesToHex(bytes) {
  return bytes.map(function(b) {
    var n = b < 0 ? b + 256 : b;
    return ('0' + n.toString(16)).slice(-2);
  }).join('');
}
