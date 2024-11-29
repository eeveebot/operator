# operator

hello operator, can you give me number nine

```bash
export KUBECONFIG="/home/epers/.kube/config-eevee-dev"
export IMG="ghcr.io/eeveebot/operator:v0.0.1"
export GOPATH="/home/epers/repos/eeveebot/operator"

go mod tidy
go mod vendor

make \
&& make generate \
&& make manifests \
&& make build-installer \
&& make docker-buildx IMG="ghcr.io/eeveebot/operator:v0.0.1 --tag ghcr.io/eeveebot/operator:latest" \
&& make install \
&& make deploy

make undeploy
```
