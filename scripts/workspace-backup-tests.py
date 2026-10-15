"""CSV representation checks only. These do not execute SQL or prove database recovery."""
import csv
import datetime
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import unittest
import uuid

FIELDS = ['id', 'user_id', 'name', 'status', 'tabs', 'active_tab_index', 'content_hash', 'created_at', 'updated_at']


def check_backup(source):
    reader = csv.DictReader(source)
    if reader.fieldnames != FIELDS:
        raise ValueError('unexpected backup columns')
    rows = list(reader)
    ids = set()
    for row in rows:
        if None in row or any(value is None for value in row.values()):
            raise ValueError('malformed CSV record')
        for field in ['id', 'user_id']:
            uuid.UUID(row[field])
        workspace_id = uuid.UUID(row['id'])
        if workspace_id in ids:
            raise ValueError('duplicate workspace ID')
        ids.add(workspace_id)
        for field in ['created_at', 'updated_at']:
            if datetime.datetime.fromisoformat(row[field].replace('Z', '+00:00')).tzinfo is None:
                raise ValueError('timestamp has no timezone')
        tabs = json.loads(row['tabs'])
        if not isinstance(tabs, list) or json.loads(json.dumps(tabs, ensure_ascii=False, allow_nan=False)) != tabs:
            raise ValueError('tabs JSON cannot round-trip')
        if not 1 <= len(row['name']) <= 200 or row['status'] not in ['active', 'review', 'revision', 'archived']:
            raise ValueError('workspace violates name/status constraints')
        if int(row['active_tab_index']) < 0 or not re.fullmatch(r'(?:[a-f0-9]{64})?', row['content_hash']):
            raise ValueError('invalid active index or content hash')
    copy = io.StringIO(newline='')
    writer = csv.DictWriter(copy, fieldnames=FIELDS)
    writer.writeheader()
    writer.writerows(rows)
    copy.seek(0)
    if list(csv.DictReader(copy)) != rows:
        raise ValueError('CSV cannot preserve original field values')
    return len(rows)


class BackupTests(unittest.TestCase):
    def fixture(self, **changes):
        row = dict(zip(FIELDS, [
            '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
            "中文, 'quoted'\nworkspace", 'active', json.dumps([{'title': '中文,"\n', 'url': 'https://example.test/?a=1&b=2', 'pinned': True, 'position': 0}], ensure_ascii=False),
            '0', '', '2026-10-15 12:00:00.123456+00:00', '2026-10-15 20:00:00.123457+08:00'
        ]))
        row.update(changes)
        output = io.StringIO(newline='')
        writer = csv.DictWriter(output, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerow(row)
        output.seek(0)
        return output

    def test_original_fields_unicode_quotes_newlines_and_microseconds(self):
        self.assertEqual(check_backup(self.fixture()), 1)

    def test_invalid_data_is_rejected(self):
        for change in [dict(id='bad'), dict(user_id=''), dict(tabs='{}'), dict(tabs='['), dict(updated_at='2026-10-15'), dict(active_tab_index='-1'), dict(content_hash='bad')]:
            with self.subTest(fields=list(change)):
                with self.assertRaises(ValueError):
                    check_backup(self.fixture(**change))

    def test_missing_columns_and_duplicate_ids_are_rejected(self):
        with self.assertRaises(ValueError):
            check_backup(io.StringIO('id,name\nfixture,fixture\n'))
        data = self.fixture().getvalue()
        header, record = data.split('\r\n', 1)
        with self.assertRaises(ValueError):
            check_backup(io.StringIO(header + '\r\n' + record + record, newline=''))


if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] != '--self-test':
        path = Path(sys.argv[1])
        with path.open(encoding='utf-8-sig', newline='') as source:
            count = check_backup(source)
        print(json.dumps({'records': count, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'database_restore_tested': False}))
    else:
        unittest.main(argv=[sys.argv[0]])
