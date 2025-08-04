#!/bin/bash

aws logs delete-log-group --log-group-name /ecs/dajp-dev-app
aws ecr delete-repository --repository-name dajp-dev-app --force
for b in $(aws s3api list-buckets --query "Buckets[?contains(Name, 'staging-infrastack')].Name" --output text); do aws s3 rm s3://$b --recursive && aws s3api delete-bucket --bucket $b; done