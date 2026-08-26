# Depois de aplicar a migration SQL, faça o deploy:
#   npx supabase functions deploy create-workspace-admin --project-ref lkoumlpmkubgpjbqyipt
#
# E no SQL Editor rode:
#   supabase/migrations/20260826140000_workspace_admins_audit.sql

Write-Host 'Deploy create-workspace-admin...'
npx supabase functions deploy create-workspace-admin --project-ref lkoumlpmkubgpjbqyipt
Write-Host 'OK. Lembre de rodar a migration SQL no Supabase.'
