const CONFIG = {
  GITHUB_OWNER: 'vonzippen',
  GITHUB_REPO: 'vonzippen',
  GITHUB_BRANCH: 'main',
  GITHUB_DIR: 'images/on-stage',
  DRIVE_FOLDER_ID: '1_lezjsTrEVMUnefn5aQPIAUQHhGH7W6F',
  GITHUB_TOKEN_PROPERTY: 'GITHUB_TOKEN',
  SYNC_STATE_PROPERTY: 'SYNC_STATE',
  BACKGROUND_TRIGGER_FUNCTION: 'backgroundSyncWorker'
};

function doGet(e) {
  var autoSync = e && e.parameter && e.parameter.sync === '1';
  var message = '';

  if (autoSync) {
    try {
      var result = startBackgroundSync();
      message = result.alreadyRunning
        ? 'A sync is already running.'
        : 'Background sync started — ' + result.total + ' photos found.';
    } catch (err) {
      message = 'Error: ' + err.message;
    }
  }

  var template = HtmlService.createTemplateFromFile('Index');
  template.autoSyncMessage = message;

  return template.evaluate()
    .setTitle('Von Zippen — On Stage Sync')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setGithubToken(token) {
  if (!token || !token.trim()) {
    throw new Error('GitHub token is empty.');
  }

  PropertiesService.getScriptProperties()
    .setProperty(CONFIG.GITHUB_TOKEN_PROPERTY, token.trim());

  return 'GitHub token saved.';
}

function getStatus() {
  return {
    driveConfigured: !!CONFIG.DRIVE_FOLDER_ID,
    githubConfigured: !!PropertiesService.getScriptProperties()
      .getProperty(CONFIG.GITHUB_TOKEN_PROPERTY),
    syncing: !!PropertiesService.getScriptProperties()
      .getProperty(CONFIG.SYNC_STATE_PROPERTY)
  };
}

function startSync() {
  return initializeSync(false);
}

function startBackgroundSync() {
  var existing = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.SYNC_STATE_PROPERTY);

  if (existing) {
    var state = JSON.parse(existing);
    return {
      alreadyRunning: true,
      total: state.items.length
    };
  }

  var result = initializeSync(true);
  scheduleBackgroundWorker();

  return {
    alreadyRunning: false,
    total: result.total
  };
}

function initializeSync(background) {
  var token = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);

  if (!token) {
    throw new Error('GitHub token is not configured.');
  }

  var folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  var items = [];
  var files = folder.getFiles();

  while (files.hasNext()) {
    var file = files.next();

    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.getMimeType())) {
      items.push({
        id: file.getId(),
        name: cleanName(file.getName())
      });
    }
  }

  items.sort(function(a, b) {
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });

  var githubByName = {};

  listGithubFiles(token).forEach(function(file) {
    githubByName[file.name] = {
      sha: file.sha
    };
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
    background: !!background
  });

  return { total: items.length };
}

function syncNextChunk() {
  return processOneItem();
}

function backgroundSyncWorker() {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    scheduleBackgroundWorker();
    return;
  }

  try {
    clearBackgroundTriggers();

    var raw = PropertiesService.getScriptProperties()
      .getProperty(CONFIG.SYNC_STATE_PROPERTY);

    if (!raw) {
      return;
    }

    var result = processOneItem();

    if (!result.done) {
      scheduleBackgroundWorker();
    }
  } finally {
    lock.releaseLock();
  }
}

function processOneItem() {
  var token = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);

  var raw = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.SYNC_STATE_PROPERTY);

  if (!token) {
    throw new Error('GitHub token is not configured.');
  }

  if (!raw) {
    throw new Error('No sync in progress. Press SYNC NOW first.');
  }

  var state = JSON.parse(raw);

  if (state.index < state.items.length) {
    var item = state.items[state.index];
    var existing = state.githubByName[item.name] || null;
    var blob = DriveApp.getFileById(item.id).getBlob();
    var driveSha = gitBlobSha1(blob.getBytes());

    if (existing && existing.sha === driveSha) {
      state.skipped++;
    } else {
      putGithubFile(
        token,
        item.name,
        blob,
        existing ? existing.sha : null,
        existing ? 'Update On Stage photo' : 'Add On Stage photo'
      );

      if (existing) {
        state.updated++;
      } else {
        state.added++;
      }
    }

    state.manifest.push(item.name);
    delete state.githubByName[item.name];
    state.index++;

    saveState(state);
    return progress(state);
  }

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
    saveState(state);

    return progress(state);
  }

  putGithubText(
    token,
    'images/on-stage.json',
    JSON.stringify({ images: state.manifest }, null, 2) + '\n',
    getGithubFileSha(token, 'images/on-stage.json'),
    'Update On Stage image manifest'
  );

  var result = {
    done: true,
    processed: state.items.length,
    total: state.items.length,
    added: state.added,
    updated: state.updated,
    skipped: state.skipped,
    removed: state.removed
  };

  PropertiesService.getScriptProperties()
    .deleteProperty(CONFIG.SYNC_STATE_PROPERTY);

  clearBackgroundTriggers();

  return result;
}

function scheduleBackgroundWorker() {
  clearBackgroundTriggers();

  ScriptApp.newTrigger(CONFIG.BACKGROUND_TRIGGER_FUNCTION)
    .timeBased()
    .after(1000)
    .create();
}

function clearBackgroundTriggers() {
  var triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === CONFIG.BACKGROUND_TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function progress(state) {
  return {
    done: false,
    processed: state.index,
    total: state.items.length,
    uploaded: state.index,
    uploadTotal: state.items.length,
    added: state.added,
    updated: state.updated,
    skipped: state.skipped,
    removed: state.removed
  };
}

function gitBlobSha1(bytes) {
  var header = Utilities.newBlob('blob ' + bytes.length + '\0').getBytes();
  return bytesToHex(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_1,
      header.concat(bytes)
    )
  );
}

function bytesToHex(bytes) {
  return bytes.map(function(b) {
    var n = b < 0 ? b + 256 : b;
    return ('0' + n.toString(16)).slice(-2);
  }).join('');
}

function saveState(state) {
  PropertiesService.getScriptProperties()
    .setProperty(CONFIG.SYNC_STATE_PROPERTY, JSON.stringify(state));
}

function cancelSync() {
  PropertiesService.getScriptProperties()
    .deleteProperty(CONFIG.SYNC_STATE_PROPERTY);
  clearBackgroundTriggers();
  return 'Sync cancelled.';
}

function cleanName(name) {
  return name.trim().replace(/[\\/:*?"<>|]/g, '-');
}

function githubUrl(path) {
  return 'https://api.github.com/repos/' +
    CONFIG.GITHUB_OWNER + '/' +
    CONFIG.GITHUB_REPO + '/contents/' +
    path.split('/').map(encodeURIComponent).join('/') +
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
  var text = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error('GitHub API ' + code + ': ' + text.slice(0, 500));
  }

  return text ? JSON.parse(text) : {};
}

function listGithubFiles(token) {
  try {
    var data = githubRequest(githubUrl(CONFIG.GITHUB_DIR), token);
    return Array.isArray(data) ? data.filter(function(x) {
      return x.type === 'file';
    }) : [];
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
  var path = CONFIG.GITHUB_DIR + '/' +
    encodeURIComponent(name).replace(/%2F/g, '/');

  var url = 'https://api.github.com/repos/' +
    CONFIG.GITHUB_OWNER + '/' +
    CONFIG.GITHUB_REPO + '/contents/' +
    path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);

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

function putGithubText(token, path, text, sha, message) {
  var url = 'https://api.github.com/repos/' +
    CONFIG.GITHUB_OWNER + '/' +
    CONFIG.GITHUB_REPO + '/contents/' +
    path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);

  var payload = {
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
  var path = CONFIG.GITHUB_DIR + '/' +
    encodeURIComponent(name).replace(/%2F/g, '/');

  var url = 'https://api.github.com/repos/' +
    CONFIG.GITHUB_OWNER + '/' +
    CONFIG.GITHUB_REPO + '/contents/' +
    path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);

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
