# eevee-operator manifests

These manifests are used to directly deploy the operator.
You can point fluxcd at this directory as a git source and it should just work.

To deploy manually:

```bash
# copy cr-samples.yaml to crs.yaml
cp cr-samples.yaml crs.yaml
# make edits as necessary (they are necessary)
$EDITOR crs.yaml

# apply crds, operator, rbac
kubectl apply --kustomize .

# apply servicemonitors (prometheus crds required)
kubectl apply -f servicemonitors.yaml

# apply bot crs
kubectl apply -f crs.yaml
```
