#!/bin/bash
cd /root/sdn-auth-main
git add .
git commit -m "Mise à jour automatique $(date)"
git push origin main
