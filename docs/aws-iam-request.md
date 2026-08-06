# AWS access request — IAM permissions for SST deploys

## What is blocked

`sst deploy --stage dev` fails partway through:

```
AccessDenied: User: arn:aws:sts::495504746201:assumed-role/
AWSReservedSSO_PowerUserAccess_a6fb76a22df96ee3/as194 is not authorized
to perform: iam:CreateRole on resource:
arn:aws:iam::495504746201:role/SchedulerExecutionRole-6de054e
```

SST provisions an execution role per Lambda function, plus an EventBridge
Scheduler execution role. AWS's managed `PowerUserAccess` policy deliberately
excludes all IAM write actions, so the deploy cannot complete. Everything that
does not require IAM already deployed successfully: four SQS queues, four DLQs,
eight CloudWatch alarms, the Cognito User Pool, and two S3 buckets.

## Who needs to act

An Identity Center administrator. The Identity Center instance
(`ssoins-722374e085e59714`) lives in the **management account
`267922946873`** — not in the workload account `495504746201` where the
deploy runs.

## Requested change

Add an inline policy to the `PowerUserAccess` permission set (or to a new
permission set assigned to the same users), then re-provision it to account
`495504746201`.

**IAM Identity Center → Permission sets → PowerUserAccess → Inline policy**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SstManagedRoles",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:ListRoleTags",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::495504746201:role/*"
    },
    {
      "Sid": "SstManagedPolicies",
      "Effect": "Allow",
      "Action": [
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:ListPolicyVersions"
      ],
      "Resource": "arn:aws:iam::495504746201:policy/*"
    },
    {
      "Sid": "ServiceLinkedRoles",
      "Effect": "Allow",
      "Action": "iam:CreateServiceLinkedRole",
      "Resource": "*"
    }
  ]
}
```

### On scoping

`Resource` is account-wide rather than name-prefixed. SST derives role names
from the construct (`SchedulerExecutionRole-6de054e`) without the `keki-dev-`
prefix it applies to most resources, so a prefix condition would break
unpredictably as constructs are added.

If account-wide IAM write is unacceptable, the tighter alternative is a
permissions boundary: allow the actions above only when the created role
carries a boundary policy that itself cannot grant IAM write. That prevents
privilege escalation while still letting SST manage its own roles. It is more
setup for the admin, so it is worth doing only if policy requires it.

## Alternatives, and why they are worse

**Admin runs the deploy once.** Creates the roles, but every future deploy that
adds a function or changes a policy needs IAM again — the admin becomes a
permanent dependency.

**Grant `AdministratorAccess`.** Unblocks everything immediately but is
strictly broader than the policy above, which is already scoped to IAM actions
on one account.

## Verifying afterwards

```bash
aws sso login
aws sts get-caller-identity
pnpm exec sst deploy --stage dev
```

The deploy should proceed past `SchedulerExecutionRole` and finish by printing
the CloudFront URL for the Next.js app.
