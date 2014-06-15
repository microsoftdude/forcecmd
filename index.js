var jsforce = require("jsforce");
var fs = require("fs");
var Promise = require("jsforce/lib/promise");
var q = require("q");
var JSZip = require("jszip");

function asArray(x) {
  if (!x) return [];
  if (x instanceof Array) return x;
  return [x];
}
function flattenArray(x) {
  return [].concat.apply([], x);
}

function writeFile(path, data) {
  var p = new Promise();
  var pos = -1;
  while (true) {
    pos = path.indexOf("/", pos + 1);
    if (pos == -1) {
      break;
    }
    (function() {
      var dir = path.substring(0, pos);
      p = p.then(function() { return q.nfcall(fs.mkdir, dir); }).then(null, function(err) { if (err.code != "EEXIST") throw err; });
    })();
  }
  return p.then(function() { return q.nfcall(fs.writeFile, path, data); });
}

var conn;
Promise
  .all([
    q.nfcall(fs.readFile, "forcecmd.json", "utf-8"),
    q.nfcall(fs.readFile, (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + "/forcepw.json", "utf-8")
  ])
  .then(function(files) {
    var file = files[0];
    var pwfile = files[1];
    var config = JSON.parse(file);
    var password = JSON.parse(pwfile).passwords[config.loginUrl + "$" + config.username];
    if (!config.loginUrl) throw "Missing loginUrl";
    if (!config.username) throw "Missing username";
    if (!password) throw "Missing password";
    conn = new jsforce.Connection({loginUrl: config.loginUrl, version: "28.0"});
    console.log("Login");
    return conn.login(config.username, password);
  })
  .then(function() {
    console.log("Describe");
    return conn.metadata.describe("28.0");
  })
  .then(function(res) {
    // TODO: Batch list calls into groups of three
    var x = res.metadataObjects
      .filter(function(metadataObject) { return metadataObject.xmlName != "InstalledPackage"; })
      .map(function(metadataObject) {
        var xmlNames = metadataObject.childXmlNames ? metadataObject.childXmlNames.concat(metadataObject.xmlName) : [metadataObject.xmlName];
        // TODO: should we avoid hardcoding the excluded component types?
        xmlNames = xmlNames.filter(function(xmlName) { return typeof xmlName == "string" && ["ApexTriggerCoupling", "WorkflowActionFlow"].indexOf(xmlName) == -1; });
        if (metadataObject.inFolder) {
          var folderType = metadataObject.xmlName == "EmailTemplate" ? "EmailFolder" : metadataObject.xmlName + "Folder";
          console.log("List " + folderType);
          var folders = conn.metadata
            .list({type: folderType})
            .then(asArray);
          return xmlNames.map(function(xmlName) {
            return folders
              .then(function(folders) {
                return Promise
                  .all(folders.map(function(folder) {
                    console.log("List " + xmlName + "/" + folder.fullName);
                    return conn.metadata.list({type: xmlName, folder: folder.fullName}).then(asArray);
                  }))
                  .then(function(p) {
                    return p.concat(folders.map(function(folder) { return {type: xmlName, fullName: folder.fullName}; }));
                  });
              })
              .then(flattenArray);
          });
        } else {
          return xmlNames.map(function(xmlName) {
            if (["AnalyticSnapshot", "RemoteSiteSetting", "ApexTriggerCoupling", "Folder", "PackageManifest", "CustomObjectSharingRules", "CustomObjectOwnerSharingRule", "CustomObjectCriteriaBasedSharingRule", "AutoResponseRule", "AssignmentRule", "EscalationRule", "Translations"].indexOf(xmlName) != -1) {
              console.log("List " + xmlName);
              return conn.metadata.list({type: xmlName}).then(asArray);
            }
            if (xmlName == "CustomObject") {
              console.log("List " + xmlName);
              return conn.metadata.list({type: xmlName}).then(function(z) {
                z = asArray(z);
                z = z.filter(function(a) { return a.fullName.indexOf("__c") == -1; });
                z.push({type: metadataObject.xmlName, fullName: "*"});
                return z;
              })
            }
            return new Promise([{type: xmlName, fullName: "*"}]);
          });
        }
      });
    return Promise.all(flattenArray(x));
  })
  .then(function (res) {
    var types = res
      .filter(function(x) { return x.length > 0})
      .map(function(x) { return {name: x[0].type, members: x.map(function(y) { return y.fullName; })}; });
    //console.log(types);
    conn.metadata.pollTimeout = 100000;
    console.log("Retrieve");
    return conn.metadata
      .retrieve({apiVersion: "28.0", unpackaged: {types: types, version: "28.0"}})
      .complete();
  })
  .then(function(res) {
    var files = [];
    var zip = new JSZip(res.zipFile, {base64: true});
    for (var p in zip.files) {
      var file = zip.files[p];
      if (!file.options.dir) {
        var name = "src/" + (file.name.indexOf("unpackaged/") == 0 ? file.name.substring("unpackaged/".length) : file.name);
        files.push(writeFile(name, file.asNodeBuffer()));
      }
    }
    console.log("Done");
    console.log(res.messages);
    return Promise.all(files);
  })
  .then(null, function(err) { console.error(err); });
