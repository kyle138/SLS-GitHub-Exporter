import { SQSClient } from "@aws-sdk/client-sqs";

const sqsClient = new SQSClient({ region: 'us-east-1' });

export { sqsClient };