# operator

hello operator, can you give me number nine

## Manual deployment

```bash
kubectl apply -f ./src/eevee/dist/install.yaml
```

## Deployment with fluxcd

```yaml
# kustomization.yaml
---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deploy.yaml
  - repo.yaml

# repo.yaml
---
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: eevee-operator
  namespace: flux-system
spec:
  interval: 1m0s
  ref:
    branch: main
  url: https://github.com/eeveebot/operator
  ignore: |
    # exclude all
    /*
    # include deploy dir
    !/src/eevee/dist

# deploy.yaml
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: eevee-operator
  namespace: flux-system
spec:
  interval: 10m0s
  path: ./src/eevee/dist
  prune: false
  sourceRef:
    kind: GitRepository
    name: eevee-operator

```

## Helpful commands

```bash
# Regenerate deployment manifests
bash ./generate.sh
```
