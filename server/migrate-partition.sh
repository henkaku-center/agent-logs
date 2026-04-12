#!/usr/bin/env bash
# Migrate course.logs to a time-partitioned table
# Run after: gcloud auth login
set -euo pipefail

PROJECT="agent-logging"
DATASET="course"

echo "Creating partitioned table..."
bq mk --table \
  --time_partitioning_field=timestamp \
  --time_partitioning_type=DAY \
  --project_id="$PROJECT" \
  "${DATASET}.logs_partitioned" \
  participant_id:STRING,project_path:STRING,session_id:STRING,file_name:STRING,offset:INTEGER,record_type:STRING,timestamp:TIMESTAMP,version:STRING,data:STRING

echo "Copying data from logs to logs_partitioned..."
bq query --use_legacy_sql=false --project_id="$PROJECT" \
  "INSERT INTO \`${PROJECT}.${DATASET}.logs_partitioned\`
   SELECT * FROM \`${PROJECT}.${DATASET}.logs\`"

echo "Verifying row counts..."
OLD=$(bq query --use_legacy_sql=false --format=csv --project_id="$PROJECT" \
  "SELECT COUNT(*) FROM \`${PROJECT}.${DATASET}.logs\`" | tail -1)
NEW=$(bq query --use_legacy_sql=false --format=csv --project_id="$PROJECT" \
  "SELECT COUNT(*) FROM \`${PROJECT}.${DATASET}.logs_partitioned\`" | tail -1)

echo "Old table: $OLD rows"
echo "New table: $NEW rows"

if [ "$OLD" = "$NEW" ]; then
  echo "Row counts match. Swapping tables..."
  bq cp -f "${PROJECT}:${DATASET}.logs" "${PROJECT}:${DATASET}.logs_backup"
  bq rm -f "${PROJECT}:${DATASET}.logs"
  bq cp "${PROJECT}:${DATASET}.logs_partitioned" "${PROJECT}:${DATASET}.logs"
  bq rm -f "${PROJECT}:${DATASET}.logs_partitioned"
  echo "Done. course.logs is now partitioned by DATE(timestamp)."
  echo "Backup at course.logs_backup (delete when confident)."
else
  echo "ERROR: Row count mismatch! Aborting swap."
  exit 1
fi
