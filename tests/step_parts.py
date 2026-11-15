"""Extract every named part (bbox + volume) from STEP assemblies -> JSON. Usage: step_parts.py <ocp_site_dir> <out.json> <step files...>"""
import sys, json, os
sys.path.insert(0, sys.argv[1])
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool
from OCP.TDF import TDF_LabelSequence, TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.TopLoc import TopLoc_Location
from OCP.IFSelect import IFSelect_RetDone

def name(lbl):
    n = TDataStd_Name()
    return n.Get().ToExtString() if lbl.FindAttribute(TDataStd_Name.GetID_s(), n) else ""

def parts_of(path):
    doc = TDocStd_Document(TCollection_ExtendedString("doc"))
    rd = STEPCAFControl_Reader(); rd.SetNameMode(True)
    assert rd.ReadFile(path) == IFSelect_RetDone
    rd.Transfer(doc)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    out = []
    def walk(lbl, loc, inst_name):
        ref = TDF_Label()
        tgt = lbl
        if XCAFDoc_ShapeTool.IsReference_s(lbl):
            XCAFDoc_ShapeTool.GetReferredShape_s(lbl, ref); tgt = ref
        kids = TDF_LabelSequence(); XCAFDoc_ShapeTool.GetComponents_s(tgt, kids, False)
        if kids.Length() == 0:
            sh = XCAFDoc_ShapeTool.GetShape_s(tgt).Moved(loc)
            b = Bnd_Box(); b.SetGap(0.0); BRepBndLib.AddOptimal_s(sh, b, False, False)
            g = GProp_GProps(); BRepGProp.VolumeProperties_s(sh, g)
            out.append({"name": inst_name or name(tgt), "ref": name(tgt), "bbox": list(b.Get()), "volume": g.Mass()})
            return
        for i in range(1, kids.Length() + 1):
            k = kids.Value(i)
            walk(k, loc.Multiplied(XCAFDoc_ShapeTool.GetLocation_s(k)), name(k))
    free = TDF_LabelSequence(); st.GetFreeShapes(free)
    for i in range(1, free.Length() + 1): walk(free.Value(i), TopLoc_Location(), "")
    return out

res = {}
for p in sys.argv[3:]:
    res[os.path.basename(p)] = parts_of(p)
    print(os.path.basename(p), len(res[os.path.basename(p)]), "parts", flush=True)
json.dump(res, open(sys.argv[2], "w"))
