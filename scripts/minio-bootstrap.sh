#!/bin/sh
# @fileoverview 初始化私有 Artifact bucket 与最小权限应用用户；不创建公开策略，也不输出凭据。
# @module deployment/minio
# @author AI生成
# @created 2026-07-22
# @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE

set -eu

alias_name="dnf-patch-local"
policy_name="dnf-patch-artifacts"
policy_file="/tmp/dnf-patch-artifacts-policy.json"
trap 'rm -f "$policy_file"' EXIT

if [ "$MINIO_ROOT_USER" = "$OBJECT_STORAGE_ACCESS_KEY" ] || \
  [ "$MINIO_ROOT_PASSWORD" = "$OBJECT_STORAGE_SECRET_KEY" ]; then
  printf '%s\n' 'MINIO_BOOTSTRAP_CREDENTIAL_REUSE' >&2
  exit 1
fi

mc alias set \
  "$alias_name" \
  "$MINIO_ENDPOINT" \
  "$MINIO_ROOT_USER" \
  "$MINIO_ROOT_PASSWORD" >/dev/null

mc mb --ignore-existing "$alias_name/$OBJECT_STORAGE_BUCKET" >/dev/null
mc anonymous set none "$alias_name/$OBJECT_STORAGE_BUCKET" >/dev/null

cat >"$policy_file" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": ["arn:aws:s3:::$OBJECT_STORAGE_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:AbortMultipartUpload",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:ListMultipartUploadParts",
        "s3:PutObject"
      ],
      "Resource": ["arn:aws:s3:::$OBJECT_STORAGE_BUCKET/*"]
    }
  ]
}
EOF

mc admin policy create "$alias_name" "$policy_name" "$policy_file" >/dev/null
mc admin user add \
  "$alias_name" \
  "$OBJECT_STORAGE_ACCESS_KEY" \
  "$OBJECT_STORAGE_SECRET_KEY" >/dev/null
mc admin policy attach \
  "$alias_name" \
  "$policy_name" \
  --user "$OBJECT_STORAGE_ACCESS_KEY" >/dev/null