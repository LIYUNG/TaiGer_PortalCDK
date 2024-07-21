import { Stack, StackProps, SecretValue } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as kms from "aws-cdk-lib/aws-kms";

// import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
// import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
// import * as sns from "aws-cdk-lib/aws-sns";
// import * as codebuild from "aws-cdk-lib/aws-codebuild";
// import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import {
    CodeBuildStep,
    CodePipeline,
    CodePipelineSource,
    // ManualApprovalStep,
    ShellStep
} from "aws-cdk-lib/pipelines";

import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as s3 from "aws-cdk-lib/aws-s3";
// import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from "aws-cdk-lib/aws-iam";
import { Region, STAGES, Stage } from "../constants";
import {
    // AWS_CODEPIPELINE_APPROVER_EMAIL,
    AWS_S3_BUCKET_DEV_FRONTEND,
    AWS_S3_BUCKET_PROD_FRONTEND,
    GITHUB_CDK_REPO,
    GITHUB_OWNER,
    GITHUB_PACKAGE_BRANCH,
    GITHUB_REPO,
    GITHUB_TOKEN
    // PIPELINE_NAME,
    // TENANT_CDK_NAME,
    // TENANT_NAME
} from "../configuration";
import { Deployment } from "./stage";

export class MyPipelineStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // Create a KMS key
        const kmsKey = new kms.Key(this, "KMSKey", {
            enableKeyRotation: true
        });

        // Create the high-level CodePipeline
        const pipeline = new CodePipeline(this, "Pipeline", {
            // artifactBucket: artifactBucket,
            crossAccountKeys: true,
            synth: new ShellStep("Synth", {
                input: CodePipelineSource.gitHub(
                    `${GITHUB_OWNER}/${GITHUB_CDK_REPO}`,
                    GITHUB_PACKAGE_BRANCH,
                    {
                        authentication: SecretValue.secretsManager(GITHUB_TOKEN),
                        trigger: codepipeline_actions.GitHubTrigger.WEBHOOK
                    }
                ),
                commands: ["npm ci", "npm run build", "npx cdk synth"]
            }),
            crossRegionReplicationBuckets: {
                [Region.IAD]: s3.Bucket.fromBucketAttributes(
                    this,
                    `crossRegionBucket-${Stage.Beta_FE}`,
                    {
                        encryptionKey: kmsKey,
                        bucketArn: AWS_S3_BUCKET_DEV_FRONTEND,
                        region: Region.IAD
                    }
                ),
                [Region.NRT]: s3.Bucket.fromBucketAttributes(
                    this,
                    `crossRegionBucket-${Stage.Prod_NA}`,
                    {
                        encryptionKey: kmsKey,
                        bucketArn: AWS_S3_BUCKET_PROD_FRONTEND,
                        region: Region.NRT
                    }
                )
            },
            codeBuildDefaults: {
                rolePolicy: [
                    new iam.PolicyStatement({
                        actions: ["*"],
                        resources: ["*"]
                    })
                ]
            }
        });

        // Add source steps for both repositories
        const sourceStep = CodePipelineSource.gitHub(
            `${GITHUB_OWNER}/${GITHUB_REPO}`,
            GITHUB_PACKAGE_BRANCH,
            {
                authentication: SecretValue.secretsManager(GITHUB_TOKEN),
                trigger: codepipeline_actions.GitHubTrigger.WEBHOOK
            }
        );

        STAGES.forEach(({ stageName, bucketArn, apiDomain, cloudfrontId, env }) => {
            // Reference existing S3 bucketArn
            const existingBucket = s3.Bucket.fromBucketAttributes(
                this,
                `ExistingBucket-${stageName}`,
                { bucketArn, region: env.region }
            );

            // CodeBuild project
            const buildStep = new CodeBuildStep(`Build-${stageName}`, {
                input: sourceStep,
                installCommands: ["cd client", "npm install"],
                commands: ["npm run test", "npm run build"],
                env: {
                    REACT_APP_STAGE: stageName,
                    REACT_APP_PROD_URL: apiDomain,
                    GENERATE_SOURCEMAP: "false",
                    CI: "true"
                },
                primaryOutputDirectory: "client/build",
                projectName: `BuildProject-${stageName}`
            });

            const deployStep = new ShellStep(`Deploy-${stageName}`, {
                input: buildStep,
                commands: ["ls", `aws s3 sync . s3://${existingBucket.bucketName}`]
            });

            const invalidateCacheStep = new ShellStep(`InvalidateCache-${stageName}`, {
                commands: [
                    `aws cloudfront create-invalidation --distribution-id ${cloudfrontId} --paths "/*"`
                ]
            });

            // const snsDeployFailedTopic = new sns.Topic(this, `${stageName}-DeployFailedTopic`, {
            //     displayName: `DeployFailedSTopic-${stageName}`
            // });

            // TODO: add slack endpoint

            // new cloudwatch.Alarm(this, `${stageName}-DeployFailedAlarm`, {
            //     alarmName: `Deploy-${stageName}-Alarm`,
            //     metric: new cloudwatch.Metric({
            //         namespace: "AWS/CodePipeline",
            //         metricName: "ActionExecution",
            //         dimensionsMap: {
            //             PipelineName: pipeline.pipelineName,
            //             StageName: "Deploy",
            //             ActionName: deployAction.actionProperties.actionName
            //         },
            //         statistic: "Sum",
            //         period: Duration.minutes(1)
            //     }),
            //     threshold: 1, // Example threshold for failure
            //     evaluationPeriods: 1,
            //     comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
            // }).addAlarmAction(new cloudwatch_actions.SnsAction(snsDeployFailedTopic));

            // // Manual approval action
            // const approvalStep = new ManualApprovalStep(`Approval-${stageName}`, {
            //     email: AWS_CODEPIPELINE_APPROVER_EMAIL
            // });

            // Add stages to the pipeline
            const Stage = new Deployment(this, `BuildDeployStage-${stageName}`, {
                stageName,
                env: { region: env.region, account: env.account }
            });
            pipeline.addStage(Stage, {
                pre: [buildStep, deployStep],
                post: [invalidateCacheStep] // can also delete the old ec2
            });
        });
    }
}
