#!/bin/zsh
cd -- "$(dirname -- "$0")"
unset ELECTRON_RUN_AS_NODE
npm start
