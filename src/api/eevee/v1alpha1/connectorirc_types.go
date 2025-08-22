package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ConnectorIrcSpec defines the desired state of ConnectorIrc
type ConnectorIrcSpec struct {
	// Size defines the number of ConnectorIrc instances
	// The following markers will use OpenAPI v3 schema to validate the value
	// More info: https://book.kubebuilder.io/reference/markers/crd-validation.html
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=1
	// +kubebuilder:validation:ExclusiveMaximum=false
	// +kubebuilder:default=1
	Size int32 `json:"size,omitempty"`

	// ContainerImage defines the container image to use
	// +kubebuilder:default="ghcr.io/eeveebot/connector-irc:latest"
	ContainerImage string `json:"containerImage,omitempty"`

	// PullPolicy defines the imagepullpolicy to use
	// +kubebuilder:default=Always
	PullPolicy string `json:"pullPolicy,omitempty"`
}

// ConnectorIrcStatus defines the observed state of ConnectorIrc
type ConnectorIrcStatus struct {
	// Represents the observations of a ConnectorIrc's current state.
	// ConnectorIrc.status.conditions.type are: "Available", "Progressing", and "Degraded"
	// ConnectorIrc.status.conditions.status are one of True, False, Unknown.
	// ConnectorIrc.status.conditions.reason the value should be a CamelCase string and producers of specific
	// condition types may define expected values and meanings for this field, and whether the values
	// are considered a guaranteed API.
	// ConnectorIrc.status.conditions.Message is a human readable message indicating details about the transition.
	// For further information see: https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#typical-status-properties

	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type" protobuf:"bytes,1,rep,name=conditions"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// ConnectorIrc is the Schema for the connectorircs API
type ConnectorIrc struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ConnectorIrcSpec   `json:"spec,omitempty"`
	Status ConnectorIrcStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// ConnectorIrcList contains a list of ConnectorIrc
type ConnectorIrcList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ConnectorIrc `json:"items"`
}

func init() {
	SchemeBuilder.Register(&ConnectorIrc{}, &ConnectorIrcList{})
}
