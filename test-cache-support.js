import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

export function useEmptyCache() {
  process.env.DYNAMODB_TABLE_NAME = 'test-cache';
  process.env.AWS_REGION = 'us-east-1';
  DynamoDBDocumentClient.prototype.send = async command => {
    if (command instanceof QueryCommand) return { Items: [] };
    if (command instanceof GetCommand || command instanceof TransactWriteCommand) return {};
    throw new Error('Unexpected DynamoDB command');
  };
}
