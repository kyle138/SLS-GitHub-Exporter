'use strict';

//
// add/configure modules
import { Octokit } from "@octokit/rest";
import { sqsClient } from "../libs/sqsClient.js";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "../libs/ddbDocClient.js";


// 
// listRepos
// Queries GitHub for list of repos associated with an organization
// Params: 
// org: {string} (required) - The organization to include in the github API query
// Returns:
// Array of repos or null
// name, owner, ref (default branch)
function listRepos(org) {
  return new Promise(async (resolve, reject) => {
    // Create authorized github client (auth allows access to private repos)
    const octokit = new Octokit({
      auth: process.env.GITHUB_PERSONAL_ACCESS_TOKEN
    });

    const results = [];

    await octokit.paginate(
      octokit.rest.repos.listForOrg, {
        org: org,
        per_page: 100,
    })
    .then((resp) => {
      console.log(resp[3]);  // DEBUG
      console.log(resp.length); // DEBUG

      results.push(
        resp.map((repo) => {
          return {
            name: repo.name,
            owner: repo.owner.login,
            ref: `refs/heads/${repo.default_branch}`
          };
        }) // End map
      );
    })  // End listForOrg.then
    .then(() => {
      return resolve(results.flat());
    })  // End listForOrg.then.then
    .catch((err) => {
      console.error(err);
      return reject(err);
    }); // End listForOrg.catch
  
  }); // End Promise
} // end listRepos

// 
// publishToSqs
// Publish the record to SQS
// Parameters:
// msg - {string} The data publish
// queue - The SQS queue url to publish to
function publishToSqs(params) {
  return new Promise( async (resolve, reject) => {
    if(!params.msg || !params.queue) {
      console.log(`publishToSqs: Queue:${params.queue} Msg:${params.msg}`);  // DEBUG:
      return reject("publishToSqs(): Msg and Queue are required fields.");
    } else {
      const command = new SendMessageCommand({
        QueueUrl: params.queue,
        MessageBody: JSON.stringify(params.msg)
      });

      await sqsClient.send(command)
      .then((resp) => {
        console.log('sqsClient:resp:: ',resp);  // DEBUG
        return resolve();
      })
      .catch((err) => {
        console.error('sqsClient:err:: ',err);
        return reject();
      }); // End sqsClient
    } // End if/else
  }); // End Promise
} // End publishToSqs

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
      // **************************
      // handleError DISABLED FOR NOW
      // **************************
      // const data = await ddbDocClient.send(new PutCommand(params));
      // console.log("handleError:put data:",JSON.stringify(data,null,2)); // DEBUG:
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

  // Check if a github personal access token has been set as an environment variable.
  // Without this we can't retrieve private repos, this is fatal.
  if(!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    console.log("process.env.GITHUB_PERSONAL_ACCESS_TOKEN missing");  // DEBUG:
    await handleError("if(process.env.GITHUB_PERSONAL_ACCESS_TOKEN)","Missing GITHUB_PERSONAL_ACCESS_TOKEN.",context);
    return new Error("Missing process.env.GITHUB_PERSONAL_ACCESS_TOKEN.");
  }

  // Check if a github organization has been set as an environment variable.
  // Without this we don't know which organization's repos to list.
  if(!process.env.GITHUB_ORGANIZATION) {
    console.log("process.env.GITHUB_ORGANIZATION missing");  // DEBUG:
    await handleError("if(process.env.GITHUB_ORGANIZATION)","Missing GITHUB_ORGANIZATION.",context);
    return new Error("Missing process.env.GITHUB_ORGANIZATION.");
  }

  // Check if exports_bucket has been set as an environment variable.
  // Without this we don't know which S3 bucket to save the Repos to.
  if(!process.env.EXPORTS_BUCKET) {
    console.error("process.env.EXPORTS_BUCKET missing"); // DEBUG:
    await handleError("if(process.env.EXPORTS_BUCKET)","Missing EXPORTS_BUCKET",context);
    return new Error("Missing process.env.EXPORTS_BUCKET.");
  }

  // Check if SQS QUEUE has been set as an environment variable.
  // Without this we don't know which queue to publish the Repos to.
  if(!process.env.SQS_QUEUE) {
    console.error("process.env.SQS_QUEUE missing"); // DEBUG:
    await handleError("if(process.env.SQS_QUEUE)","Missing SQS_QUEUE",context);
    return new Error("Missing process.env.SQS_QUEUE.");
  }

  // Now that the validation checks are out of the way...

  await listRepos(process.env.GITHUB_ORGANIZATION)
  .then(async (repos) => {
    console.log(JSON.stringify(repos,null,2));  // DEBUG

    return await Promise.all(
      repos.map(async (repo) => await publishToSqs({
        queue: process.env.SQS_QUEUE,
        msg: repo
      })) // End map
    );  // End Promise.all
  })// End listRepos.then
  .then(() => {
    console.log("Qapla'"); // DEBUG:
    return { message: 'All records submitted to SQS.' };
  })  // End loadSettings.then.then.then
  .catch(async (err) => {
    console.log("Promise.all.catch:",err);  // DEBUG:
    await handleError("Promise.all.catch", err, context);
    throw new Error("bortaS bIr jablu'DI' reH QaQqu' nay'");
  }); // End Promise.all.catch

};  // End handler

