#!/bin/sh
# Idempotent MinIO bootstrap for the production stack (run by the `minio-init` compose service):
# a private bucket plus an app account limited to that bucket. Secrets come from the environment.
set -eu

: "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}" "${S3_ACCESS_KEY_ID:?}" "${S3_SECRET_ACCESS_KEY:?}" "${S3_BUCKET:?}"

export MC_CONFIG_DIR=/tmp/mc
mc alias set pod http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "pod/$S3_BUCKET" >/dev/null
mc anonymous set none "pod/$S3_BUCKET" >/dev/null

policy=/tmp/pod-app-policy.json
cat > "$policy" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET}"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET}/*"]
    }
  ]
}
EOF
mc admin policy create pod pod-app "$policy" >/dev/null
# `user add` creates the account or resets its secret, keeping it in step with ops/prod/.env.
mc admin user add pod "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
# Attaching an already attached policy fails; anything else is a real error.
if ! out=$(mc admin policy attach pod pod-app --user "$S3_ACCESS_KEY_ID" 2>&1); then
  case "$out" in
    *"already"*) ;;
    *) echo "$out" >&2; exit 1 ;;
  esac
fi
echo "[minio-init] bucket ${S3_BUCKET} ready, app user ${S3_ACCESS_KEY_ID} limited to it"
