'use strict';

/**
 * Object storage (S3-compatible: SeaweedFS locally and in k3d, R2 or S3 in production). Nothing is
 * written to local disk (CLAUDE.md Kubernetes rules). Tests use an in-memory driver.
 */
const config = require('../config');

const memory = new Map();
let client;
let bucketReady = false;

function s3() {
  if (!client) {
    if (!config.s3.endpoint && !config.isProd) throw new Error('S3_ENDPOINT is not set');
    const { S3Client } = require('@aws-sdk/client-s3');
    client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: config.s3.accessKey ? { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey } : undefined,
    });
  }
  return client;
}

async function ensureBucket(bucket) {
  const { CreateBucketCommand } = require('@aws-sdk/client-s3');
  try {
    await s3().send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(err?.name)) throw err;
  }
}

/** Store an object in the private bucket. */
async function putPrivate(key, body, contentType) {
  if (config.storage.driver === 'memory') {
    memory.set(key, { body: Buffer.from(body), contentType });
    return { key };
  }
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  // SeaweedFS answers a missing bucket with a 500 InternalError rather than NoSuchBucket, so where
  // bucket creation is allowed (local, k3d) the bucket is ensured once per process before the first write.
  if (config.s3.createBuckets && !bucketReady) {
    await ensureBucket(config.s3.privateBucket);
    bucketReady = true;
  }
  await s3().send(new PutObjectCommand({ Bucket: config.s3.privateBucket, Key: key, Body: body, ContentType: contentType }));
  return { key };
}

/** Read an object from the private bucket as { body: Readable | Buffer, contentType }. */
async function getPrivate(key) {
  if (config.storage.driver === 'memory') {
    const obj = memory.get(key);
    if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return obj;
  }
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res = await s3().send(new GetObjectCommand({ Bucket: config.s3.privateBucket, Key: key }));
  return { body: res.Body, contentType: res.ContentType };
}

module.exports = { putPrivate, getPrivate, _memory: memory };
