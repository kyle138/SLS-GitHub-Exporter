'use strict';

//
// add/configure modules
import { promises as fs } from 'fs';
import { Octokit } from '@octokit/rest';
import download from 'download';
import { s3Client } from "../libs/s3Client.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../libs/ddbDocClient.js";
import { S3SyncClient } from 's3-sync-client'; 
import { TransferMonitor } from 's3-sync-client';

const { sync } = new S3SyncClient({ client: s3Client });
const monitor = new TransferMonitor();

//
// deployS3
// Sync the local archive to the S3 bucket
function deployS3(source, destination) {
  return new Promise( async (resolve,reject) => {
    if(!source || !destination) {
      console.log("deployS3: source or destination missing.");
      return reject("deployS3(): source and destination are both required arguments.");

    } else {
      // console.log(`source: ${source}\r\ndestination: ${destination}`);  // DEBUG
      monitor.on('progress', (progress) => console.log(progress));

      const params = {
        partSize: 100 * 1024 * 1024, // uses multipart uploads for files higher than 100MB
        monitor,  // monitor transfer progress
        commandInput: { // pass AWS SDK command input options
          ContentType: "application/zip"  // Set content-type to zip
        }
      };  

      // Sync the local directory to S3
      await sync(source, `s3://${destination}`, params)
      .then((data) => {
        console.log('sync done',data); //DEBUG
        return resolve();
      })
      .catch((err) => {
        console.log('sync err:',err); 
        return reject(new Error('deployS3:sync error'));
      }); // End sync

    } // End if source/destination
  }); // End Promise
} // End deployS3

//
// handleError
// Writes error message to DDB errorTable for reporting
function handleError(method, message, context) {
  return new Promise(async (resolve) => {
    var errorMessage = {
      lambdaFunctionName: context.functionName,
      eventTimeUTC: new Date().toUTCString(),
      methodName: method,
      error: message
    }; // End errorMessage
    console.log("handleError: " + JSON.stringify(errorMessage)); // DEBUG:

    const params = {
      TableName: 'errorLogs',
      Item: {
        // DDB ttl to expire item after 1 month
        ttl: Math.floor(Date.now() / 1000) + 2592000,
        data: errorMessage
      }
    }; // End params

    // Load the DDB client and write the errorLogs
    // Now everybody gonna know what you did.
    try {
      console.log("DDB params:: ",JSON.stringify(params,null,2)); // DEBUG:
      const data = await ddbDocClient.send(new PutCommand(params));
      console.log("handleError:put data:",JSON.stringify(data,null,2)); // DEBUG:
      return resolve();

    } catch (err) {
      console.log("Unable to add DDB item to errorLogs: " ,err);
      // Yes this is an error, but we don't want it to kill the lambda.
      return resolve();

    }
  }); // End Promise
} // End handleError

export const handler = async (event, context) => {
  console.log("Received event: " + JSON.stringify(event,null,2)); // DEBUG

  // The SQS event can contain multiple records but it's currently set to send single records in serverless.yml
  // For now just process 1 record but this may be changed.
  const evt_obj = JSON.parse(event.Records[0].body);
  console.log(JSON.stringify(evt_obj,null,2));  // DEBUG yeah I parsed it to stringify it, fight me

  // Check if a github personal access token has been set as an environment variable.
  // Without this we can't retrieve private repos, this is fatal.
  if(!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    console.log("process.env.GITHUB_PERSONAL_ACCESS_TOKEN missing");  // DEBUG:
    await handleError("if(process.env.GITHUB_PERSONAL_ACCESS_TOKEN)","Missing GITHUB_PERSONAL_ACCESS_TOKEN.",context);
    return new Error("Missing process.env.GITHUB_PERSONAL_ACCESS_TOKEN.");
  }

  // Check if exports_bucket has been set as an environment variable.
  // Without this we don't know which S3 bucket to save the Repos to.
  if(!process.env.EXPORTS_BUCKET) {
    console.error("process.env.EXPORTS_BUCKET missing"); // DEBUG:
    await handleError("if(process.env.EXPORTS_BUCKET)","Missing EXPORTS_BUCKET",context);
    return new Error("Missing process.env.EXPORTS_BUCKET.");
  }

  // Now that the validation checks are out of the way...

  // Create authorized github client (auth allows access to private repos)
  const octokit = new Octokit({
      auth: process.env.GITHUB_PERSONAL_ACCESS_TOKEN
  });

  // Retrieve archive of repo from GitHub
  await octokit.rest.repos.downloadZipballArchive({
    owner: evt_obj.owner,
    repo: evt_obj.name,
    ref: evt_obj.ref
  })  // End downloadZipballArchive
  .then(async (ghArchive) => {
    // Save the repo archive locally to /tmp/"repo name"/"repo name".zip
    let lcl_dir = `/tmp/${evt_obj.name}`;
    return await fs.mkdir(lcl_dir, {recursive: true})
    .then(async () => {
      await fs.writeFile(`${lcl_dir}/${evt_obj.name}.zip`, await download(ghArchive.url));
      return lcl_dir;
    });
  })  // End downloadZipballArchive.then
  .then(async (lcl_dir)=> {
    // Sync the local file to S3
    let s3_dir = `${process.env.EXPORTS_BUCKET}/GitHub`;
    await deployS3(lcl_dir, s3_dir);
    return {
      lcl_dir: lcl_dir,
      s3_dir: s3_dir
    };
  })  // End downloadZipballArchive.then.then
  .then((file_obj) => {
    console.log(`File: ${file_obj.lcl_dir} synced to ${file_obj.s3_dir}`);
    return "Alright, alright, alright.";
  })  // End downloadZipballArchive.then.then.then
  .catch(async (err) => {
    console.log("Error Caught: ",err);  // DEBUG:
    await handleError("Error Caught", err, context);
    return new Error("Deploy failed.");  // Deploy failed, report back to SQS to try again.
  }); // End downloadZipballArchive.catch

}; // End exports.handler
