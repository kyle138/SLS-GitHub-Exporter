# SLS-GitHub-Exporter
Serverless stack to retrieve zipped archives of all GitHub repositories for an organization and store in AWS S3 Glacier. This consists of two decoupled **cron** and **processor** handlers utilizing SQS. The cron handler queries the GitHub API to retrieve a list of repositories, it then publishes that list to SQS (1 repo per message). The processor handler is triggered by SQS with a max concurrency of 10. For each SQS message it requests a zipped archive of the designated repo from its default branch (master or main) then saves that zip in S3.  

## Note:
- After cloning or pulling changes remember to run 'npm install' from the following directories:   
  - /
  - layers/CommonModules/nodejs
  - layers/ProcessModules/nodejs
- Copy config/config-example.json to config/config.json and fill in the following values:
  - ```github_personal_access_token``` - Created within github, this token grants access to private repos.
  - ```github_organization``` - The organization name that owns the repos.
  - ```exports_bucket``` - The S3 bucket to copy the repo exports to.

## Components:  
- **Layers:** 
  - ```CommonModules``` Lambda layer with the following NPM modules:
    - @octokit/rest - Used for GitHub API communication
  - ```ProcessModules``` Lambda layer with the following NPM modules:
    - download - Used to download the zip archive
    - s3-sync-client - Used to save the zip archive to S3
  - **Cron** (01 05 1 * ? *) - Triggers the cron lambda.
  - **Lambda:** ```cronGithub``` Lambda function which:
    - Queries GitHub API for list of repositories
    - Retrieves 'name', 'organization', and 'default branch' for each repo
    - Publishes list of repos to SQS
  - **SQS:** ```${stage}-githubExports``` Queue that stores repos to be processed
  - **Lambda:** ```processGithub``` Lambda function which:
    - Receives SQS message containing repo name, organization, and ref
    - Queries GitHub API to create download link of repo archive
    - Downloads repo archive to local /tmp
    - Uploads repo archive from local /tmp to S3://${config.export_bucket}

## External Components:
The following components are not part of the serverless.yml configuration:
- **S3 bucket:** This stack assumes that the S3 export_bucket specified in config/config.json already exists. The bucket should a GitHub/ folder created and Lifecycle rules in place to transition the contents of the GitHub/ folder to Glacier.
- **GitHub Access Token:** The github_personal_access_token specified in config/config.json needs to be generated in GitHub.



