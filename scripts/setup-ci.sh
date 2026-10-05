#!/usr/bin/env bash
# One-time setup so GitHub Actions can deploy to the VM without a stored key.
#
# Creates a deploy service account, a Workload Identity pool that trusts only
# pushes to main on this repo, grants the account SSH + sudo on the VM through
# OS Login, and stores the provider and account names as GitHub secrets.
#
# Run from the repo root with gcloud pointed at the right project and gh logged
# in to an account with admin access to the repo. Also uploads the app secrets from .env.
set -euo pipefail

REPO=push-based/virtual-office-notifier
INSTANCE=${DEPLOY_INSTANCE:-virtual-office-notifier}
ZONE=${DEPLOY_ZONE:-us-central1-a}
PROJECT_ID=${DEPLOY_PROJECT:-$(gcloud config get-value project)}
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
POOL=github
SA_NAME=github-deploy
SA="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

gcloud services enable iamcredentials.googleapis.com oslogin.googleapis.com --project="$PROJECT_ID"

gcloud iam service-accounts create "$SA_NAME" \
  --project="$PROJECT_ID" --display-name="GitHub Actions deploy"

gcloud iam workload-identity-pools create "$POOL" \
  --project="$PROJECT_ID" --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "$POOL" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref \
  --attribute-condition="assertion.repository == '$REPO' && assertion.ref == 'refs/heads/main'"

gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project="$PROJECT_ID" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO"

# OS Login keeps the runner's throwaway SSH keys in the account's profile
# instead of the VM metadata. osAdminLogin grants sudo.
gcloud compute instances add-metadata "$INSTANCE" \
  --project="$PROJECT_ID" --zone="$ZONE" --metadata=enable-oslogin=TRUE

for role in roles/compute.instanceAdmin.v1 roles/compute.osAdminLogin; do
  gcloud compute instances add-iam-policy-binding "$INSTANCE" \
    --project="$PROJECT_ID" --zone="$ZONE" --member="serviceAccount:$SA" --role="$role"
done

# gcloud compute ssh/scp read the project metadata to pick an SSH method. A
# custom role grants just that, rather than project-wide osAdminLogin, which
# would mean sudo on every VM in the project.
gcloud iam roles create githubDeployProjectReader \
  --project="$PROJECT_ID" --title="GitHub deploy project reader" \
  --description="Lets gcloud compute ssh/scp read project metadata" \
  --permissions=compute.projects.get --stage=GA

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role="projects/$PROJECT_ID/roles/githubDeployProjectReader" \
  --condition=None

# Logging in over OS Login to a VM with an attached service account requires
# permission to act as that account.
VM_SA=$(gcloud compute instances describe "$INSTANCE" \
  --project="$PROJECT_ID" --zone="$ZONE" --format='value(serviceAccounts[0].email)')
if [[ -n "$VM_SA" ]]; then
  gcloud iam service-accounts add-iam-policy-binding "$VM_SA" \
    --project="$PROJECT_ID" --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser
fi

gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$REPO" \
  --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$POOL"
gh secret set GCP_SERVICE_ACCOUNT --repo "$REPO" --body "$SA"
gh secret set --repo "$REPO" -f .env

echo "Done. The next push to main deploys."
