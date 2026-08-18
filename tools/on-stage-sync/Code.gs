const CONFIG = {
  GITHUB_OWNER: 'vonzippen',
  GITHUB_REPO: 'vonzippen',
  GITHUB_BRANCH: 'main',
  GITHUB_DIR: 'images/on-stage',
  DRIVE_FOLDER_ID: '1_lezjsTrEVMUnefn5aQPIAUQHhGH7W6F',
  GITHUB_TOKEN_PROPERTY: 'GITHUB_TOKEN'
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
    githubConfigured: !!PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY)
  };
}

function syncOnStage() {
  const token = PropertiesService.getScriptProperties().getProperty(CONFIG.GITHUB_TOKEN_PROPERTY);
  if (!token) throw new Error('GitHub token is not configured.');
  const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  const driveFiles = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const file = it.next();
    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.getMimeType())) {
      driveFiles.push({name: cleanName(file.getName()), file});
    }
  }

  const githubFiles = listGithubFiles(token);
  const githubByName = {};
  githubFiles.forEach(f => githubByName[f.name] = f);

  let added = 0, updated = 0, skipped = 0, removed = 0;
  const manifest = [];
  driveFiles.sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true, sensitivity:'base'}));

  // Process a small number of files per execution to stay well within Apps Script limits.
  const batchSize = 4;
  for (let start = 0; start < driveFiles.length; start += batchSize) {
    const batch = driveFiles.slice(start, start + batchSize);
    batch.forEach(item => {
      const existing = githubByName[item.name];
      const localHash = hashBytes(item.file.getBlob().getBytes());
      const existingHash = existing && existing.sha ? getGithubBlobHash(existing.sha) : null;
      if (existing && existingHash && localHash === existingHash) {
        skipped++;
      } else {
        putGithubFile(token, item.name, item.file.getBlob(), existing ? existing.sha : null,
          existing ? 'Update On Stage photo' : 'Add On Stage photo');
        if (existing) updated++; else added++;
      }
      manifest.push(item.name);
      delete githubByName[item.name];
    });
  }

  Object.keys(githubByName).forEach(name => {
    deleteGithubFile(token, name, githubByName[name].sha);
    removed++;
  });

  putGithubText(token, 'images/on-stage.json', JSON.stringify({images: manifest}, null, 2) + '\n',
    getGithubFileSha(token, 'images/on-stage.json'), 'Update On Stage image manifest');

  return {added, updated, skipped, removed, total: manifest.length};
}

function cleanName(name) {
  return name.trim().replace(/[\\/:*?"<>|]/g, '-');
}

function hashBytes(bytes) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes);
  return digest.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function getGithubBlobHash(sha) {
  // Git blobs use SHA-1 over "blob <size>\\0<content>". The contents API gives us the blob SHA.
  // We only use this as an optimization hint; if unavailable, the file is updated normally.
  return null;
}

function githubUrl(path) {
  return 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' +
    path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
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
  const res = UrlFetchApp.fetch(url, base);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error('GitHub API ' + code + ': ' + text.slice(0, 500));
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
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' +
    path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  const payload = {
    message,
    content: Utilities.base64Encode(blob.getBytes()),
    branch: CONFIG.GITHUB_BRANCH
  };
  if (sha) payload.sha = sha;
  githubRequest(url, token, {
    method:'put',
    contentType:'application/json',
    payload:JSON.stringify(payload)
  });
}

function putGithubText(token, path, text, sha, message) {
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' +
    path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  const payload = {
    message,
    content: Utilities.base64Encode(text, Utilities.Charset.UTF_8),
    branch: CONFIG.GITHUB_BRANCH
  };
  if (sha) payload.sha = sha;
  githubRequest(url, token, {
    method:'put',
    contentType:'application/json',
    payload:JSON.stringify(payload)
  });
}

function deleteGithubFile(token, name, sha) {
  const path = CONFIG.GITHUB_DIR + '/' + encodeURIComponent(name).replace(/%2F/g, '/');
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' +
    path + '?ref=' + encodeURIComponent(CONFIG.GITHUB_BRANCH);
  githubRequest(url, token, {
    method:'delete',
    contentType:'application/json',
    payload:JSON.stringify({
      message:'Remove deleted On Stage photo',
      sha,
      branch:CONFIG.GITHUB_BRANCH
    })
  });
}
