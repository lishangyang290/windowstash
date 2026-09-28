#!/bin/zsh

set -euo pipefail

read 'WINDOWSTASH_TEST_EMAIL?测试邮箱: '
read -s 'WINDOWSTASH_TEST_PASSWORD?测试密码（输入时不会显示）: '
print

export WINDOWSTASH_TEST_EMAIL WINDOWSTASH_TEST_PASSWORD
trap 'unset WINDOWSTASH_TEST_EMAIL WINDOWSTASH_TEST_PASSWORD' EXIT

node --env-file=.env scripts/create-test-user.mjs
